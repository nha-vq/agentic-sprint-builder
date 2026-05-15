import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RUN_LIMITS } from '@/lib/config/limits';
import { createTimestampRunId, runSprintBuilder } from '@/lib/orchestrator';
import { completeRunStatus, createRunStatus, failRunStatus, updateRunProgress } from '@/lib/runs/run-status-store';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const maxDuration = 900;

const RunRequestSchema = z.object({
  requirements: z.string().min(10).max(RUN_LIMITS.requirementsChars),
  techSpec: z.string().max(RUN_LIMITS.techSpecChars).nullable().optional(),
  apiSpec: z.string().max(RUN_LIMITS.apiSpecChars).optional(),
  topic: z.string().max(RUN_LIMITS.topicChars).optional()
});

function errorResponse(error: unknown) {
  if (error instanceof ApiGuardError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Invalid run request.',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      },
      { status: 400 }
    );
  }

  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  console.error('[runs] Request failed', error);
  return NextResponse.json({ error: 'Run failed. Check server logs for details.' }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);
    const body = RunRequestSchema.parse(await request.json());
    const asyncMode = request.nextUrl.searchParams.get('async') === 'true';

    if (!asyncMode) {
      const result = await runSprintBuilder(body);
      return NextResponse.json(result);
    }

    const runId = `${createTimestampRunId()}-${Math.random().toString(36).slice(2, 7)}`;
    const topic = body.topic || 'Simple Shopping Cart App';
    const snapshot = createRunStatus(runId, topic);

    void runSprintBuilder(body, {
      runId,
      onProgress: (update) => {
        updateRunProgress(runId, update);
      }
    })
      .then((result) => completeRunStatus(runId, result))
      .catch((error) => {
        console.error('[runs] Background run failed', error);
        failRunStatus(runId, error);
      });

    updateRunProgress(runId, {
      level: 'info',
      message: 'Run started in the background.'
    });

    return NextResponse.json({ ...snapshot, status: 'RUNNING' }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
