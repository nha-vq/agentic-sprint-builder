import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import { z } from 'zod';
import type { DevOutput, GeneratedExecutionValidationResult, GeneratedFile, QAReviewOutput, RunResult } from '@/lib/types';

const QAReviewOutputSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_FIX']),
  findings: z.array(z.string()),
  fixInstructions: z.string(),
  report: z.string()
});

const QAReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'fixInstructions', 'report'],
  properties: {
    status: {
      type: 'string',
      enum: ['PASS', 'NEEDS_FIX']
    },
    findings: {
      type: 'array',
      items: { type: 'string' }
    },
    fixInstructions: { type: 'string' },
    report: { type: 'string' }
  }
};

export async function runQAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  devOutput: DevOutput;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  executionValidation?: GeneratedExecutionValidationResult;
}): Promise<QAReviewOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);

  const raw = await runMarkdownSkillAgent({
    agentId: 'qa',
    maxTokens: 16_384,
    jsonSchema: {
      name: 'qa_review_output',
      schema: QAReviewJsonSchema
    },
    userPrompt: `
Validate the Phase 1 delivery and produce QA artifacts.

Return JSON only.

Use status "NEEDS_FIX" if generated files are not locally runnable/buildable, missing dependency manifests,
missing setup commands, likely fail at runtime, fail to satisfy acceptance criteria, or have blocking integration bugs.
Use status "PASS" only if the generated delivery appears complete, runnable, and aligned to scope.

For setup/build readiness, inspect whether the DEV output includes the files needed to run the generated app:
- Every generated project needs root README.md and .env.example.
- Every generated service owned by the project needs a Dockerfile unless containers are out of scope.
- Docker Compose is required only when generated, requested, or appropriate for local project-owned services/databases.
- Frontend projects need package.json and runnable scripts.
- Tailwind projects need Tailwind/PostCSS config.
- FastAPI projects need requirements.txt and an app entrypoint.
- The database type must match requirements or tech spec.
- Project-owned databases need migrations/schema initialization and safe seed data when needed.
- External/pre-existing databases need documented env vars, non-destructive connection handling, and health/connectivity checks; they should not be recreated or seeded destructively.
- Generated projects need smoke tests and documented test commands.
- Frontend/backend integration needs matching API URLs and CORS where applicable.
- The orchestrator starts generated frontend on port 3001 and backend on port 8000 by default; FastAPI CORS should allow localhost/127.0.0.1 on port 3001.

If status is "NEEDS_FIX", provide concise fixInstructions addressed to the DEV agent.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${techSpec}

BA OUTPUT:
${input.baOutput}

DEV OUTPUT:
${JSON.stringify(input.devOutput, null, 2)}

EXECUTION VALIDATION RESULT:
${input.executionValidation ? JSON.stringify(input.executionValidation, null, 2) : 'Not provided.'}

CURRENT GENERATED CODE SNAPSHOT:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });

  return QAReviewOutputSchema.parse(extractJsonObject(raw));
}
