import { NextRequest, NextResponse } from 'next/server';
import { createDashboardCompanyRecord, getDashboardIdentitySnapshot } from '@/lib/dashboard';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);
    await createDashboardCompanyRecord({ replaceExisting: true });
    return NextResponse.json({
      ...getDashboardIdentitySnapshot(),
      info: 'Existing saved dashboard agents/company were replaced. New company id is cached and saved to .env.local.'
    });
  } catch (error) {
    if (error instanceof ApiGuardError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Dashboard company creation failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
