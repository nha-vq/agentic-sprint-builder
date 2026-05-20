import { NextRequest, NextResponse } from 'next/server';
import { deleteDashboardCompany } from '@/lib/dashboard';

export const runtime = 'nodejs';

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('company_id') || undefined;

    const result = await deleteDashboardCompany(companyId);

    if (!result.deleted) {
      return NextResponse.json(
        { error: 'No company_id available to delete. Register first or provide ?company_id=...' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ...result,
      message: `Company ${result.company_id} deleted from dashboard.`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
