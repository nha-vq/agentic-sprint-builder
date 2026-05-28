import { NextRequest, NextResponse } from 'next/server';
import { emitDashboardEvent, getDashboardIdentitySnapshotWithConnectivity } from '@/lib/dashboard';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);
    const event = await emitDashboardEvent({
      agentId: 'ba',
      eventType: 'THINKING',
      task: 'Dashboard diagnostic event from Agentic Sprint Builder',
      toAgent: 'tech-stack',
      artifact: 'dashboard-diagnostic',
      forceRemote: true
    });

    return NextResponse.json({
      event,
      status: await getDashboardIdentitySnapshotWithConnectivity()
    });
  } catch (error) {
    if (error instanceof ApiGuardError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : 'Dashboard event test failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
