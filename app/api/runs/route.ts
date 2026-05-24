import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RUN_LIMITS } from '@/lib/config/limits';
import { createTimestampRunId, runSprintBuilder } from '@/lib/orchestrator';
import { AGENT_MODEL_IDS } from '@/lib/agent-models';
import { clearRunController, completeRunStatus, createRunStatus, failRunStatus, isRunCanceled, registerRunController, updateRunProgress } from '@/lib/runs/run-status-store';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const maxDuration = 900;

const RequirementImageSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().positive().max(RUN_LIMITS.requirementImageBytes),
  dataUrl: z.string().min(1).refine(
    (value) => /^data:image\/(png|jpeg|webp);base64,/.test(value),
    'dataUrl must be a valid base64 data URL with image mime type'
  )
});

const AgentModelSchema = z.enum(AGENT_MODEL_IDS);
const AgentModelsSchema = z
  .object({
    ba: AgentModelSchema.optional(),
    'tech-stack': AgentModelSchema.optional(),
    dev: AgentModelSchema.optional(),
    'frontend-dev': AgentModelSchema.optional(),
    'backend-dev': AgentModelSchema.optional(),
    'integration-dev': AgentModelSchema.optional(),
    'code-review': AgentModelSchema.optional(),
    deploy: AgentModelSchema.optional(),
    qa: AgentModelSchema.optional()
  })
  .partial();

const RunRequestSchema = z.object({
  requirements: z.string().min(10).max(RUN_LIMITS.requirementsChars),
  techSpec: z.string().max(RUN_LIMITS.techSpecChars).nullable().optional(),
  apiSpec: z.string().max(RUN_LIMITS.apiSpecChars).optional(),
  topic: z.string().max(RUN_LIMITS.topicChars).optional(),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80).optional(),
  requirementImages: z.array(RequirementImageSchema).max(RUN_LIMITS.requirementImages).nullable().optional(),
  agentModels: AgentModelsSchema.nullable().optional()
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
    const topic = body.topic || 'AI Team Run';
    const snapshot = createRunStatus(runId, topic);
    const controller = new AbortController();
    registerRunController(runId, controller);

    void runSprintBuilder(body, {
      runId,
      signal: controller.signal,
      onProgress: (update) => {
        updateRunProgress(runId, update);
      }
    })
      .then((result) => {
        clearRunController(runId);
        completeRunStatus(runId, result);
      })
      .catch((error) => {
        clearRunController(runId);
        if (isRunCanceled(runId)) return;
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
