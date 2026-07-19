// Shared plumbing for the airport-import runners (plain Node, no build step).
// Pure helpers here mirror lib/airport-import/types.ts — keep the twins in sync.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Env / Supabase ───────────────────────────────────────────────────────────

/**
 * Parse .env.local (values may be quoted — quotes are stripped).
 * @returns {{ url: string, serviceRoleKey: string }}
 */
export function loadSupabaseEnv() {
  const envPath = path.join(REPO_ROOT, '.env.local');
  const text = readFileSync(envPath, 'utf8');
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }
  return { url, serviceRoleKey };
}

/** Service-role Supabase client (bypasses RLS; server-side only). */
export function createServiceClient() {
  const { createClient } = require('@supabase/supabase-js');
  const { url, serviceRoleKey } = loadSupabaseEnv();
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Throw on a PostgREST error, with context. */
export function must(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message ?? JSON.stringify(error)}`);
  return data;
}

/**
 * Run a Supabase call with bounded retries on TRANSIENT network failures only
 * (thrown "fetch failed" / socket errors). PostgREST-level errors (constraint
 * violations etc.) surface via must() and are never retried.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn  builder invocation returning {data,error}
 * @returns {Promise<T>}
 */
export async function withNetRetry(label, fn, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? err);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|terminated/i.test(msg);
      if (!transient) throw err;
      lastErr = err;
      if (attempt < retries) {
        console.warn(`${label}: transient network error (${msg}); retry ${attempt + 1}/${retries}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${label}: exhausted retries: ${lastErr?.message ?? lastErr}`);
}

/**
 * Select all rows of a table in bounded pages.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} table
 * @param {string} columns
 * @param {(q: any) => any} [applyFilter]
 * @param {{ pageSize?: number, maxPages?: number }} [opts]
 */
export async function selectAll(sb, table, columns, applyFilter, opts = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 200; // hard bound: 200k rows
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await withNetRetry(`selectAll(${table}) page ${page}`, async () => {
      let q = sb.from(table).select(columns).range(page * pageSize, (page + 1) * pageSize - 1);
      if (applyFilter) q = applyFilter(q);
      return must(`selectAll(${table}) page ${page}`, await q);
    });
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
  throw new Error(`selectAll(${table}): exceeded maxPages=${maxPages} — refusing unbounded pagination`);
}

// ── Import lineage (airport_data_imports) ────────────────────────────────────

/**
 * If the latest succeeded import for `source` carries the same checksum,
 * record a short-circuit row and return it; else null.
 */
export async function shortCircuitIfUnchanged(sb, source, checksum, sourceVersion, effectiveDate) {
  const prior = must('lookup prior import', await sb
    .from('airport_data_imports')
    .select('id, checksum, status')
    .eq('source', source)
    .eq('status', 'succeeded')
    .eq('checksum', checksum)
    .order('started_at', { ascending: false })
    .limit(1));
  if (!prior.length) return null;
  const row = must('record short-circuit import', await sb
    .from('airport_data_imports')
    .insert({
      source,
      source_version: sourceVersion,
      effective_date: effectiveDate,
      checksum,
      status: 'succeeded',
      counts: { skipped: 'unchanged' },
      error_summary: `checksum unchanged from import ${prior[0].id}; no work performed`,
      finished_at: new Date().toISOString(),
    })
    .select('id')
    .single());
  return row.id;
}

/** Insert a running airport_data_imports row; returns its id. */
export async function startImport(sb, source, { sourceVersion, effectiveDate, checksum } = {}) {
  const row = must('start import', await sb
    .from('airport_data_imports')
    .insert({
      source,
      source_version: sourceVersion ?? null,
      effective_date: effectiveDate ?? null,
      checksum: checksum ?? null,
      status: 'running',
    })
    .select('id')
    .single());
  return row.id;
}

/** Finish an airport_data_imports row. */
export async function finishImport(sb, importId, status, counts, errorSummary) {
  must('finish import', await sb
    .from('airport_data_imports')
    .update({
      status,
      counts,
      error_summary: errorSummary ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', importId));
}

// ── Bounded network fetch ────────────────────────────────────────────────────

// faa.gov's WAF 403s non-browser user agents; identify as a mainstream browser.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * fetch() with an explicit AbortController timeout (default 30s), at most
 * `retries` retries (default 2), and a hard response-size bound.
 * @param {string} url
 * @param {{ timeoutMs?: number, retries?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchBounded(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new Error(`response too large (${declared} > ${maxBytes} bytes)`);
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(timer);
      return Buffer.concat(chunks);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`fetchBounded failed for ${url}: ${lastErr?.message ?? lastErr}`);
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Minimal zip entry extraction (stored + deflate; no zip64) ────────────────

/**
 * Extract a single entry from a zip buffer via the central directory.
 * @param {Buffer} buf
 * @param {string} entryName
 * @returns {Buffer}
 */
export function extractZipEntry(buf, entryName) {
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 65_558);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: corrupt central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip: unsupported compression method ${method}`);
    }
    names.push(name);
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: entry ${entryName} not found; entries: ${names.slice(0, 20).join(', ')}`);
}

// ── CSV (RFC 4180: quoted fields, embedded commas/newlines, CRLF) ────────────

/**
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Map a CSV header row to column indices; throws if a required column is missing. */
export function indexColumns(headerRow, requiredColumns) {
  /** @type {Record<string, number>} */
  const idx = {};
  headerRow.forEach((name, i) => { idx[name.trim()] = i; });
  const missing = requiredColumns.filter((c) => !(c in idx));
  if (missing.length) {
    throw new Error(`CSV header missing required columns: ${missing.join(', ')}. Header seen: ${headerRow.join(', ')}`);
  }
  return idx;
}

// ── Pure helpers (twins of lib/airport-import/types.ts) ──────────────────────

export const NASR_SITE_TYPE = {
  A: 'airport',
  B: 'balloonport',
  C: 'seaplane_base',
  G: 'gliderport',
  H: 'heliport',
  U: 'ultralight',
};

export const NASR_MILITARY_OWNERSHIP = new Set(['MA', 'MN', 'MR', 'CG']);
export const DETECTION_RADIUS_AIRPORT_M = 2500;
export const DETECTION_RADIUS_OTHER_M = 800;

const TITLE_SMALL_WORDS = new Set(['of', 'the', 'at', 'on', 'and', 'for', 'de', 'la']);
const TITLE_KEEP_UPPER = /^(?:[IVX]+|USA|US|AFB|AAF|NAS|NAF|MCAS|ANGB|ANG|JB|LLC|Inc\.?)$/i;

/** @param {string} raw */
export function titleCaseName(raw) {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;
  const words = trimmed.split(' ').map((word, wi) => {
    if (TITLE_KEEP_UPPER.test(word)) return word.toUpperCase();
    const lower = word.toLowerCase();
    if (wi > 0 && TITLE_SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-/(.])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
  });
  return words.join(' ');
}

/** @param {string} raw */
export function normalizeName(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function chunkArray(items, size) {
  if (size < 1) throw new Error('chunkArray: size must be >= 1');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isValidIcao(value) {
  return !!value && /^[A-Z0-9]{4}$/.test(value);
}

export function isValidIata(value) {
  return !!value && /^[A-Z0-9]{3}$/.test(value);
}

/** FAA hub / service-level classification → airports.service_class (or null). */
export function classifyServiceClass(serviceLevel, hub) {
  const sl = String(serviceLevel ?? '').trim().toUpperCase();
  const h = String(hub ?? '').trim().toUpperCase();
  if (sl === 'P') {
    if (h === 'L') return 'large_hub';
    if (h === 'M') return 'medium_hub';
    if (h === 'S') return 'small_hub';
    return 'nonhub_primary';
  }
  if (sl === 'CS') return 'nonprimary_commercial';
  if (sl === 'R') return 'reliever';
  if (sl === 'GA') return 'general_aviation';
  return null;
}

export const COMMERCIAL_SERVICE_CLASSES = new Set([
  'large_hub', 'medium_hub', 'small_hub', 'nonhub_primary', 'nonprimary_commercial',
]);

/**
 * Run `fn` over items with bounded concurrency; propagates the first error.
 * @template T
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} fn
 */
export async function forEachLimit(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
