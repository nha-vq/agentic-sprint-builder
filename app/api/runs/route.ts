import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RUN_LIMITS } from '@/lib/config/limits';
import { runSprintBuilder } from '@/lib/orchestrator';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const maxDuration = 120;

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
    const result = await runSprintBuilder(body);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
