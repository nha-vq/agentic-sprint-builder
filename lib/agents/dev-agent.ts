import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { RUN_LIMITS } from '@/lib/config/limits';
import { extractJsonObject } from '@/lib/utils/json';
import type { DevOutput, RunResult } from '@/lib/types';

const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string()
});

const DevOutputSchema = z
  .object({
    architecture: z.string().max(20_000),
    files: z.array(GeneratedFileSchema).max(RUN_LIMITS.generatedFiles),
    setupInstructions: z.string().max(20_000)
  })
  .superRefine((output, context) => {
    let totalBytes = 0;

    output.files.forEach((file, index) => {
      const fileBytes = Buffer.byteLength(file.content, 'utf8');
      totalBytes += fileBytes;

      if (fileBytes > RUN_LIMITS.generatedFileBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'content'],
          message: `Generated file exceeds ${RUN_LIMITS.generatedFileBytes} bytes.`
        });
      }
    });

    if (totalBytes > RUN_LIMITS.generatedTotalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `Generated output exceeds ${RUN_LIMITS.generatedTotalBytes} total bytes.`
      });
    }
  });

const DevOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['architecture', 'files', 'setupInstructions'],
  properties: {
    architecture: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        }
      }
    },
    setupInstructions: { type: 'string' }
  }
};

export async function runDevAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  existingFiles?: Array<{ path: string; content: string }>;
  recentRuns?: RunResult[];
  previousDevOutput?: DevOutput;
  qaFeedback?: string;
  apiSpec?: string;
}): Promise<DevOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCode = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const previousDevOutput = input.previousDevOutput
    ? JSON.stringify(input.previousDevOutput, null, 2)
    : 'No previous DEV output.';
  const qaFeedback = input.qaFeedback?.trim() || 'No QA feedback yet.';

  const raw = await runMarkdownSkillAgent({
    agentId: 'dev',
    fallbackTemperature: 0.1,
    jsonSchema: {
      name: 'dev_output',
      schema: DevOutputJsonSchema
    },
    userPrompt: `
Generate the Phase 1 implementation files. Return JSON only.

If existing generated code is provided, update that existing project instead of creating a brand-new project layout.
Return only files that should be created or overwritten in the fixed generated-code workspace.
The generated code must be runnable locally after writing the returned files.
Include all required manifests, dependency files, scripts, seed data, and configuration needed to run/build the app.
For a Next.js frontend, include package.json, next config if needed, Tailwind/PostCSS config when Tailwind is used, and scripts for dev/build/start.
For a FastAPI backend, include requirements.txt, CORS config for the frontend port, app entrypoint, and seed data when the UI needs data.
If QA feedback is provided, preserve the existing project shape and return corrected files that address every blocking issue.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${techSpec}

BA OUTPUT:
${input.baOutput}

EXISTING GENERATED CODE:
${existingCode}

PREVIOUS DEV OUTPUT:
${previousDevOutput}

RECENT RUN HISTORY:
${runHistoryContext}

QA OR BUILD FEEDBACK TO FIX:
${qaFeedback}

DASHBOARD API SPEC:
${input.apiSpec || 'Not provided'}
`
  });

  try {
    return DevOutputSchema.parse(extractJsonObject(raw));
  } catch (error) {
    console.error(`[dev-agent] Expected JSON output, got: ${raw.slice(0, 500)}`);
    throw error;
  }
}
