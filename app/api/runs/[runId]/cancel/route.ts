import { NextRequest, NextResponse } from 'next/server';
import { cancelRunStatus } from '@/lib/runs/run-status-store';
import { ApiGuardError, assertRunStatusApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  if (error instanceof ApiGuardError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  console.error('[runs/cancel] Request failed', error);
  return NextResponse.json({ error: 'Run cancel failed.' }, { status: 500 });
}

export async function POST(request: NextRequest, { params }: { params: { runId: string } }) {
  try {
    assertRunStatusApiAccess(request);
    const snapshot = cancelRunStatus(params.runId);
    if (!snapshot) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });

    return NextResponse.json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}
