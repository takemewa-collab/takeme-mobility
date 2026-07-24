/**
 * Environment gate for legal documents.
 *
 * A driver must never be asked to accept draft or legally unapproved copy.
 * The platform's seeded documents are explicitly marked
 * "DRAFT — PENDING LEGAL COUNSEL REVIEW" pending counsel sign-off, and the
 * owning requirement carries config.legal_review_pending. Until approved
 * copy ships, production builds FAIL SAFELY: the acceptance UI is replaced
 * by an internal-configuration notice and no consent is collected.
 * Development builds may display drafts, always behind an explicit
 * development-preview banner.
 */

export interface GateableDocument {
  key: string;
  version: string | number;
  title: string;
  body: string;
  effectiveAt: string | null;
}

export type LegalGateMode =
  /** Approved documents — collect acceptance normally. */
  | 'accept'
  /** Draft copy in a development build — show, clearly marked, never silent. */
  | 'dev_preview'
  /** Draft/unapproved copy in a production build — do not collect acceptance. */
  | 'blocked';

/** Shown to support/engineering when production is blocked. */
export const LEGAL_GATE_REFERENCE = 'LEGAL_COPY_UNAPPROVED';

const DRAFT_MARKER = /\bDRAFT\b[\s\S]{0,80}?\bLEGAL\b|\bPENDING LEGAL COUNSEL\b/i;

/**
 * A document is acceptance-eligible only when it carries no draft marking
 * and has an effective date. Anything ambiguous counts as unapproved —
 * the failure mode must be "block acceptance", never "treat draft as final".
 */
export function isApprovedDocument(doc: GateableDocument): boolean {
  const head = `${doc.title}\n${doc.body.slice(0, 400)}`;
  if (DRAFT_MARKER.test(head)) return false;
  if (!doc.effectiveAt) return false;
  return true;
}

export function unapprovedDocuments(docs: GateableDocument[]): GateableDocument[] {
  return docs.filter((d) => !isApprovedDocument(d));
}

export function gateLegalDocuments(
  docs: GateableDocument[],
  options: { legalReviewPending: boolean; isDevBuild: boolean },
): LegalGateMode {
  const anyUnapproved = options.legalReviewPending || unapprovedDocuments(docs).length > 0;
  if (!anyUnapproved) return 'accept';
  return options.isDevBuild ? 'dev_preview' : 'blocked';
}
