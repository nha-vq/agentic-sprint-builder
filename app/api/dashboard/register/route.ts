import { NextResponse } from 'next/server';
import { registerDashboardCompany } from '@/lib/dashboard';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const result = await registerDashboardCompany();
    return NextResponse.json({
      ...result,
      info: result.dashboardDisabled
        ? 'Dashboard is disabled (ENABLE_DASHBOARD != true). Company not created on remote.'
        : `Company "${result.name}" registered. company_id is cached in-memory for this process.`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
