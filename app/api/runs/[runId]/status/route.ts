import { NextRequest, NextResponse } from 'next/server';
import { readRunResult } from '@/lib/storage/file-writer';
import { getRunStatus } from '@/lib/runs/run-status-store';
import { ApiGuardError, assertRunStatusApiAccess } from '@/lib/security/api-guard';
import type { RunResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  if (error instanceof ApiGuardError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  console.error('[runs/status] Request failed', error);
  return NextResponse.json({ error: 'Status lookup failed.' }, { status: 500 });
}

function resultHasBlockingIssues(result: RunResult) {
  return (
    result.executionValidation?.status === 'NEEDS_FIX' ||
    result.qaStatus === 'NEEDS_FIX' ||
    result.deployValidationStatus === 'NEEDS_FIX' ||
    result.codeReviewStatus === 'NEEDS_FIX'
  );
}

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  try {
    assertRunStatusApiAccess(request);
    const active = getRunStatus(params.runId);
    if (active) return NextResponse.json(active);

    const result = await readRunResult(params.runId);
    if (!result) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
    const hasBlockingIssues = resultHasBlockingIssues(result);

    return NextResponse.json({
      runId: result.runId,
      status: 'COMPLETED',
      createdAt: result.createdAt,
      updatedAt: result.createdAt,
      topic: result.topic,
      currentStepId: 'complete',
      steps: [
        { id: 'complete', label: 'Done', status: hasBlockingIssues ? 'FAIL' : 'PASS' }
      ],
      logs: [
        {
          timestamp: result.createdAt,
          level: hasBlockingIssues ? 'warn' : 'success',
          message: hasBlockingIssues ? 'Run finished with blocking issues. Open the run output or report for findings.' : 'Run completed.'
        }
      ],
      result
    });
  } catch (error) {
    return errorResponse(error);
  }
}
