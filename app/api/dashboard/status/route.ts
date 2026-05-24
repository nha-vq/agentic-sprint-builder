import { NextRequest, NextResponse } from 'next/server';
import { getDashboardIdentitySnapshot } from '@/lib/dashboard';
import { ApiGuardError, assertRunStatusApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    assertRunStatusApiAccess(request);
    return NextResponse.json(getDashboardIdentitySnapshot());
  } catch (error) {
    if (error instanceof ApiGuardError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Dashboard status lookup failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
