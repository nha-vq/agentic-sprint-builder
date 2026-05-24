import { NextRequest, NextResponse } from 'next/server';
import { createDashboardAgents, deleteDashboardAgents, getDashboardIdentitySnapshot } from '@/lib/dashboard';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';

function companyIdFromRequest(request: NextRequest) {
  return request.nextUrl.searchParams.get('company_id') || undefined;
}

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);
    await createDashboardAgents(companyIdFromRequest(request));
    return NextResponse.json({
      ...getDashboardIdentitySnapshot(),
      info: 'Dashboard agent ids are cached and saved to .env.local.'
    });
  } catch (error) {
    if (error instanceof ApiGuardError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Dashboard agent creation failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertRunApiAccess(request);
    const result = await deleteDashboardAgents(companyIdFromRequest(request));
    return NextResponse.json({
      ...getDashboardIdentitySnapshot(),
      deleteResult: result,
      info: result.warnings.length ? `Deleted local agent ids with ${result.warnings.length} dashboard warning(s).` : 'Dashboard agent ids deleted.'
    });
  } catch (error) {
    if (error instanceof ApiGuardError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Dashboard agent deletion failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
