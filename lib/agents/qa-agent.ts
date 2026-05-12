import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import { z } from 'zod';
import type { DevOutput, GeneratedFile, QAReviewOutput, RunResult } from '@/lib/types';

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
}): Promise<QAReviewOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);

  const raw = await runMarkdownSkillAgent({
    agentId: 'qa',
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
- Frontend projects need package.json and runnable scripts.
- Tailwind projects need Tailwind/PostCSS config.
- FastAPI projects need requirements.txt and an app entrypoint.
- Frontend/backend integration needs matching API URLs and CORS where applicable.

If status is "NEEDS_FIX", provide concise fixInstructions addressed to the DEV agent.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${techSpec}

BA OUTPUT:
${input.baOutput}

DEV OUTPUT:
${JSON.stringify(input.devOutput, null, 2)}

CURRENT GENERATED CODE SNAPSHOT:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });

  return QAReviewOutputSchema.parse(extractJsonObject(raw));
}
