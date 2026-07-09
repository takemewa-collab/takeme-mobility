import { NextRequest, NextResponse } from 'next/server';
import { getDLQItems, getDLQLength, retryFromDLQ, clearDLQ } from '@/lib/redis';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// GET /api/dispatch/dlq — View dead-letter queue items
// POST /api/dispatch/dlq — Retry one item from DLQ
// DELETE /api/dispatch/dlq — Clear DLQ
//
// Protected by CRON_SECRET (fail closed)

function isAuthorized(request: NextRequest): boolean {
  return verifyInternalRequest(request);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [items, length] = await Promise.all([getDLQItems(50), getDLQLength()]);
    return NextResponse.json({ length, items });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to read DLQ' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const item = await retryFromDLQ();
    if (!item) {
      return NextResponse.json({ message: 'DLQ is empty' });
    }
    return NextResponse.json({ retried: true, rideId: item.rideId, previousAttempts: item.attempts });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to retry from DLQ' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const cleared = await clearDLQ();
    return NextResponse.json({ cleared });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to clear DLQ' }, { status: 500 });
  }
}
