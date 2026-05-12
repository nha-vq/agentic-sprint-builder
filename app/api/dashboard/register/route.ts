import { NextResponse } from 'next/server';
import { registerDashboardCompany } from '@/lib/dashboard';

export const runtime = 'nodejs';

export async function POST() {
  try {
    const result = await registerDashboardCompany();
    return NextResponse.json({
      ...result,
      nextStep: 'Copy company_id into DASHBOARD_COMPANY_ID in .env.local and restart dev server.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
