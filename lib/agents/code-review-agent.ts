import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedProjectOverview } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import type { DevOutput, GeneratedFile, PreparedTechStackOutput } from '@/lib/types';

const CodeReviewFindingSchema = z.object({
  category: z.string(),
  file: z.string(),
  finding: z.string(),
  fix: z.string().optional()
});

const CodeReviewOutputSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_FIX']),
  blocking: z.array(CodeReviewFindingSchema),
  advisory: z.array(CodeReviewFindingSchema.omit({ fix: true })),
  summary: z.string(),
  requirementCoverage: z.string()
});

export type CodeReviewOutput = z.infer<typeof CodeReviewOutputSchema>;

const CodeReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'blocking', 'advisory', 'summary', 'requirementCoverage'],
  properties: {
    status: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'file', 'finding', 'fix'],
        properties: {
          category: { type: 'string' },
          file: { type: 'string' },
          finding: { type: 'string' },
          fix: { type: 'string' }
        }
      }
    },
    advisory: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'file', 'finding'],
        properties: {
          category: { type: 'string' },
          file: { type: 'string' },
          finding: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' },
    requirementCoverage: { type: 'string' }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export async function runCodeReviewAgent(input: {
  requirements: string;
  baOutput: string;
  devOutput: DevOutput;
  preparedTechStack?: PreparedTechStackOutput;
  existingFiles?: GeneratedFile[];
  signal?: AbortSignal;
}): Promise<CodeReviewOutput> {
  const projectOverview = formatGeneratedProjectOverview(input.existingFiles ?? input.devOutput.files);
  const fileList = input.devOutput.files
    .map((file) => `## ${file.path}\n\`\`\`\n${truncate(file.content, 3_000)}\n\`\`\``)
    .join('\n\n');

  const raw = await runMarkdownSkillAgent({
    agentId: 'code-review',
    fallbackTemperature: 0.2,
    maxTokens: 16_384,
    signal: input.signal,
    jsonSchema: {
      name: 'code_review_output',
      schema: CodeReviewJsonSchema
    },
    userPrompt: `
Review the generated code against the requirements, BA output, and prepared tech stack.

REQUIREMENTS:
${truncate(input.requirements, 4_000)}

BA OUTPUT:
${truncate(input.baOutput, 6_000)}

PREPARED TECH STACK:
${input.preparedTechStack ? JSON.stringify(input.preparedTechStack, null, 2) : 'Not provided'}

GENERATED PROJECT OVERVIEW:
${projectOverview}

ARCHITECTURE:
${truncate(input.devOutput.architecture, 2_000)}

GENERATED FILES:
${truncate(fileList, 60_000)}

Review for: architecture consistency, requirement coverage, code quality, Docker setup, env usage, API consistency, frontend/backend integration, and security basics.
Return JSON only.
`
  });

  return CodeReviewOutputSchema.parse(extractJsonObject(raw));
}
