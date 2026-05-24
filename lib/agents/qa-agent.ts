import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedProjectOverview, formatRunHistoryContext } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import { z } from 'zod';
import type { DevOutput, GeneratedExecutionValidationResult, GeneratedFile, PreparedTechStackOutput, QAReviewOutput, RunResult } from '@/lib/types';

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

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function isTruncationError(error: unknown) {
  return error instanceof Error && /truncated|finish_reason.*length|max_tokens|incomplete json|started a json object but did not finish/i.test(error.message);
}

function fileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function isQaRelevantFile(file: GeneratedFile) {
  const name = fileName(file.path);
  const normalized = file.path.replace(/\\/g, '/').toLowerCase();
  return (
    name === 'readme.md' ||
    name === '.env.example' ||
    name.endsWith('.env.example') ||
    name === 'package.json' ||
    name === 'requirements.txt' ||
    name === 'pyproject.toml' ||
    name === 'dockerfile' ||
    name === 'containerfile' ||
    /^(compose|docker-compose)\.ya?ml$/.test(name) ||
    /(^|\/)(main|app|server|database|models|schemas|seed)[._-]?[a-z0-9]*\.(py|ts|tsx|js|jsx)$/.test(normalized) ||
    /(^|\/)(tests?|__tests__)\/|(\.|_)(test|spec)\./.test(normalized)
  );
}

function formatFileInventory(files: GeneratedFile[]) {
  if (files.length === 0) return 'No generated files.';

  return files
    .map((file) => `- ${file.path} (${Buffer.byteLength(file.content, 'utf8')} bytes)`)
    .join('\n');
}

function formatRelevantFileExcerpts(files: GeneratedFile[], compact: boolean) {
  const limit = compact ? 8 : 14;
  const charsPerFile = compact ? 1_000 : 2_000;
  const relevant = files.filter(isQaRelevantFile).slice(0, limit);
  if (relevant.length === 0) return 'No QA-relevant file excerpts were selected.';

  return relevant
    .map((file) => `### ${file.path}\n\`\`\`\n${truncate(file.content, charsPerFile)}\n\`\`\``)
    .join('\n\n');
}

function formatDevOutputSummary(output: DevOutput, compact: boolean) {
  return [
    `Architecture:\n${truncate(output.architecture, compact ? 1_500 : 3_000)}`,
    `Setup instructions:\n${truncate(output.setupInstructions, compact ? 1_500 : 3_000)}`,
    `Generated file inventory:\n${formatFileInventory(output.files)}`
  ].join('\n\n');
}

function formatExecutionValidationSummary(validation: GeneratedExecutionValidationResult | undefined, compact: boolean) {
  if (!validation) return 'Not provided.';

  const steps = validation.steps
    .map((step) => {
      const logFile = step.logFile ? ` log=${step.logFile}` : '';
      return `- ${step.name}: ${step.status}${logFile}\n  ${truncate(step.message, compact ? 500 : 1_000)}`;
    })
    .join('\n');

  return [
    `Status: ${validation.status}`,
    `Workspace: ${validation.workspace}`,
    `Findings:\n${validation.findings.length ? validation.findings.map((finding) => `- ${truncate(finding, compact ? 500 : 1_000)}`).join('\n') : '- none'}`,
    `Steps:\n${steps}`
  ].join('\n\n');
}

function buildQaPrompt(input: {
  requirements: string;
  techSpec: string;
  preparedTechStack?: PreparedTechStackOutput;
  baOutput: string;
  devOutput: DevOutput;
  existingFiles: GeneratedFile[];
  recentRuns: RunResult[];
  executionValidation?: GeneratedExecutionValidationResult;
  compact: boolean;
}) {
  return `
Use the loaded QA skill to validate the generated delivery and produce QA artifacts.

Return JSON only.

Apply the QA skill as the source of review behavior, blocking criteria, validation expectations, and report structure.
The application source only provides context below. Do not infer extra QA policy from this prompt.
Keep findings, fixInstructions, and report concise. If status is "NEEDS_FIX", address fixInstructions to the DEV agent.

REQUIREMENTS:
${truncate(input.requirements, input.compact ? 1_500 : 3_000)}

TECH SPEC:
${truncate(input.techSpec, input.compact ? 1_000 : 2_000)}

PREPARED TECH STACK:
${input.preparedTechStack ? truncate(JSON.stringify(input.preparedTechStack, null, 2), input.compact ? 1_500 : 3_000) : 'Not provided.'}

BA OUTPUT:
${truncate(input.baOutput, input.compact ? 2_000 : 4_000)}

DEV OUTPUT SUMMARY:
${formatDevOutputSummary(input.devOutput, input.compact)}

GENERATED PROJECT OVERVIEW:
${formatGeneratedProjectOverview(input.existingFiles)}

EXECUTION VALIDATION RESULT:
${formatExecutionValidationSummary(input.executionValidation, input.compact)}

QA-RELEVANT GENERATED FILE EXCERPTS:
${formatRelevantFileExcerpts(input.existingFiles, input.compact)}

RECENT RUN HISTORY:
${truncate(formatRunHistoryContext(input.recentRuns), input.compact ? 3_000 : 5_000)}
`;
}

export async function runQAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  preparedTechStack?: PreparedTechStackOutput;
  baOutput: string;
  devOutput: DevOutput;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  executionValidation?: GeneratedExecutionValidationResult;
  modelOverride?: string;
  signal?: AbortSignal;
}): Promise<QAReviewOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await runMarkdownSkillAgent({
        agentId: 'qa',
        modelOverride: input.modelOverride,
        maxTokens: attempt === 1 ? 12_288 : 16_384,
        jsonSchema: {
          name: 'qa_review_output',
          schema: QAReviewJsonSchema
        },
        signal: input.signal,
        userPrompt: buildQaPrompt({
          requirements: input.requirements,
          techSpec,
          preparedTechStack: input.preparedTechStack,
          baOutput: input.baOutput,
          devOutput: input.devOutput,
          existingFiles: input.existingFiles ?? [],
          recentRuns: input.recentRuns ?? [],
          executionValidation: input.executionValidation,
          compact: attempt > 1
        })
      });

      return QAReviewOutputSchema.parse(extractJsonObject(raw));
    } catch (error) {
      lastError = error;
      if (!isTruncationError(error) && attempt > 1) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('QA response was invalid JSON.');
}
