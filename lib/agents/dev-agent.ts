import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { RUN_LIMITS } from '@/lib/config/limits';
import { extractJsonObject } from '@/lib/utils/json';
import { formatRepairScope } from '@/lib/validation/repair-scope';
import type { DevOutput, GeneratedFile, RepairScope, RunProgressReporter, RunResult } from '@/lib/types';

const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string()
});

const GeneratedFileBatchSchema = z.object({
  files: z.array(GeneratedFileSchema).min(1).max(RUN_LIMITS.generatedFiles)
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

const DevManifestSchema = z.object({
  architecture: z.string().max(20_000),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        purpose: z.string().max(2_000)
      })
    )
    .max(RUN_LIMITS.generatedFiles),
  setupInstructions: z.string().max(20_000)
});

type DevManifest = z.infer<typeof DevManifestSchema>;

const DevManifestJsonSchema = {
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
        required: ['path', 'purpose'],
        properties: {
          path: { type: 'string' },
          purpose: { type: 'string' }
        }
      }
    },
    setupInstructions: { type: 'string' }
  }
};

const GeneratedFileJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' }
  }
};

const GeneratedFileBatchJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: GeneratedFileJsonSchema
    }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function isTruncationError(error: unknown) {
  return error instanceof Error && /truncated|finish_reason.*length|max_tokens|incomplete json|started a json object but did not finish/i.test(error.message);
}

function getDevFileBatchSize() {
  const parsed = Number.parseInt(process.env.DEV_FILE_BATCH_SIZE || process.env.GENERATED_FILE_BATCH_SIZE || '4', 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(5, Math.max(1, parsed));
}

function normalizeGeneratedPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function basename(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function orderedUnique(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter((filePath) => {
    const normalized = normalizeGeneratedPath(filePath);
    if (!filePath || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function findExistingFile(files: GeneratedFile[] | undefined, targetPath: string) {
  return files?.find((file) => normalizeGeneratedPath(file.path) === normalizeGeneratedPath(targetPath));
}

function formatPreviousDevOutput(output?: DevOutput) {
  if (!output) return 'No previous DEV output.';

  return JSON.stringify(
    {
      architecture: output.architecture,
      setupInstructions: output.setupInstructions,
      files: output.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8')
      }))
    },
    null,
    2
  );
}

function selectScopedRepairPaths(params: {
  repairScope: RepairScope;
  qaFeedback: string;
}) {
  const candidates = orderedUnique(params.repairScope.candidatePaths);
  const text = params.qaFeedback.toLowerCase();
  const referenced = candidates.filter((filePath) => text.includes(normalizeGeneratedPath(filePath)) || text.includes(basename(filePath)));

  if (referenced.length > 0) return referenced.slice(0, 6);

  if (params.repairScope.kind === 'docker') {
    const containerFiles = candidates.filter((filePath) => /(^|\/)(dockerfile|containerfile|(compose|docker-compose)\.ya?ml)$/i.test(filePath));
    if (containerFiles.length > 0) return containerFiles.slice(0, 4);
  }

  if (params.repairScope.kind === 'docs') {
    const docs = candidates.filter((filePath) => /(^|\/)(readme\.md|.*\.env\.example|\.env\.example)$/i.test(filePath));
    if (docs.length > 0) return docs.slice(0, 4);
  }

  return candidates.slice(0, 6);
}

function pathAllowedByRepairScope(filePath: string, repairScope: RepairScope) {
  const normalized = normalizeGeneratedPath(filePath);
  if (repairScope.candidatePaths.some((candidate) => normalizeGeneratedPath(candidate) === normalized)) return true;

  return repairScope.allowedDirectories.some((directory) => {
    const normalizedDirectory = normalizeGeneratedPath(directory);
    if (normalizedDirectory === '.') return !normalized.includes('/');
    return normalized === normalizedDirectory || normalized.startsWith(`${normalizedDirectory}/`);
  });
}

function applyRepairScopeToManifest(manifest: DevManifest, repairScope?: RepairScope): DevManifest {
  if (!repairScope) return manifest;

  const filteredFiles = manifest.files.filter((file) => pathAllowedByRepairScope(file.path, repairScope));
  if (filteredFiles.length > 0) return { ...manifest, files: filteredFiles };

  if (repairScope.requiresPlanning) return { ...manifest, files: [] };

  return {
    ...manifest,
    files: selectScopedRepairPaths({ repairScope, qaFeedback: '' }).map((filePath) => ({
      path: filePath,
      purpose: `Fix ${repairScope.label}: ${repairScope.instructions}`
    }))
  };
}

function buildScopedRepairManifest(params: {
  repairScope: RepairScope;
  qaFeedback: string;
  previousDevOutput?: DevOutput;
}) {
  return DevManifestSchema.parse({
    architecture: params.previousDevOutput?.architecture || `Scoped repair for existing generated project. Scope: ${params.repairScope.label}.`,
    setupInstructions: params.previousDevOutput?.setupInstructions || 'Re-run the failed validation step after applying the scoped file repair.',
    files: selectScopedRepairPaths({
      repairScope: params.repairScope,
      qaFeedback: params.qaFeedback
    }).map((filePath) => ({
      path: filePath,
      purpose: `Fix ${params.repairScope.label}: ${params.repairScope.instructions}`
    }))
  });
}

function buildDevContext(input: {
  requirements: string;
  techSpec: string;
  baOutput: string;
  existingCode: string;
  previousDevOutput: string;
  runHistoryContext: string;
  qaFeedback: string;
  repairScope?: RepairScope;
  apiSpec?: string;
}) {
  return `
If existing generated code is provided, update that existing project instead of creating a brand-new project layout.
Return only files that should be created or overwritten in the fixed generated-code workspace.
The generated code must be runnable locally after writing the returned files.
Include all required manifests, dependency files, scripts, seed data, and configuration needed to run/build the app.
Always include root README.md with exact setup, build, run, test, health-check, and port instructions.
Always include root .env.example with safe local defaults only. Never include real credentials or secrets.
For services owned by the generated project, include Dockerfiles unless containers are explicitly out of scope.
Choose the database type from the requirements or tech spec. Do not default to PostgreSQL unless requested or clearly appropriate.
If requirements say a database already exists or provide a connection string/API, treat it as external: document env vars, do not create/overwrite it, and avoid destructive schema changes.
For local full-stack apps where Docker is appropriate, include a Compose file.
For project-owned databases, include schema/migrations or an init script plus safe seed data.
For external databases, include non-destructive connectivity checks and health/readiness handling instead of local database initialization.
Include automated smoke tests and package scripts where supported.
The generated frontend is started by this tool on port 3001 by default, and the backend on port 8000.
Use a frontend API base URL environment variable such as NEXT_PUBLIC_API_BASE_URL or VITE_API_BASE_URL with a default of http://127.0.0.1:8000.
FastAPI CORS must allow http://localhost:3001, http://127.0.0.1:3001, and the same origins on port 3000 for compatibility.
Only say Compose initializes the database when the generated project actually owns and starts that database.
If QA feedback is provided, preserve the existing project shape and return corrected files that address every blocking issue.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${input.techSpec}

BA OUTPUT:
${input.baOutput}

EXISTING GENERATED CODE:
${input.existingCode}

PREVIOUS DEV OUTPUT SUMMARY:
${input.previousDevOutput}

RECENT RUN HISTORY:
${input.runHistoryContext}

QA OR BUILD FEEDBACK TO FIX:
${input.qaFeedback}

SCOPED REPAIR CONSTRAINTS:
${formatRepairScope(input.repairScope)}

DASHBOARD API SPEC:
${input.apiSpec || 'Not provided'}
`;
}

async function requestDevManifest(params: {
  devContext: string;
  repairScope?: RepairScope;
  onProgress?: RunProgressReporter;
}) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const manifestRaw = await runMarkdownSkillAgent({
        agentId: 'dev',
        fallbackTemperature: 0.1,
        maxTokens: attempt === 1 ? 8_192 : 12_288,
        jsonSchema: {
          name: 'dev_manifest',
          schema: DevManifestJsonSchema
        },
        userPrompt: `
Plan the implementation. Return JSON only.

Return a compact manifest only: architecture, setupInstructions, and files with path + purpose.
Do not include file content in this response.
Keep setupInstructions concise. Avoid markdown lists inside JSON strings.
Keep the file list minimal but complete enough for the project to build, run, test, and validate.
${attempt > 1 ? 'Previous manifest response failed or was truncated. Return shorter valid JSON only.' : ''}
${params.repairScope ? 'This is a scoped incremental repair. Prefer candidate files from SCOPED REPAIR CONSTRAINTS. If a new file is required, create it only inside one of the allowed generated-code directories listed there.' : ''}

${params.devContext}
`
      });

      return applyRepairScopeToManifest(DevManifestSchema.parse(extractJsonObject(manifestRaw)), params.repairScope);
    } catch (error) {
      lastError = error;
      await params.onProgress?.({
        stepId: 'dev',
        stepStatus: 'RUNNING',
        level: 'warn',
        message: `DEV retrying implementation manifest; ${isTruncationError(error) ? 'response was truncated' : 'provider returned invalid JSON'} on attempt ${attempt}.`
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error('DEV manifest response was invalid JSON.');
}

function buildBatchFileContext(input: {
  requirements: string;
  techSpec: string;
  baOutput: string;
  qaFeedback: string;
  repairScope?: RepairScope;
  manifest: DevManifest;
  manifestFiles: DevManifest['files'];
  existingFiles?: GeneratedFile[];
}) {
  const existingSections = input.manifestFiles
    .map((manifestFile) => {
      const existingContent = findExistingFile(input.existingFiles, manifestFile.path)?.content;
      return `## ${manifestFile.path}\n${existingContent ? truncate(existingContent, 4_000) : 'No existing file content for this target path.'}`;
    })
    .join('\n\n');

  return `
PROJECT CONTRACT:
- Generate complete, runnable files for the target paths only.
- Match the database type and external-vs-owned database choice from requirements/tech spec.
- Use environment variables for service/database connections.
- Do not include real secrets.
- Keep each file focused and reasonably small.

TARGET FILES:
${JSON.stringify(input.manifestFiles, null, 2)}

ARCHITECTURE:
${truncate(input.manifest.architecture, 4_000)}

SETUP INSTRUCTIONS:
${truncate(input.manifest.setupInstructions, 3_000)}

PROJECT FILE MANIFEST:
${input.manifest.files.map((file) => `- ${file.path}: ${file.purpose}`).join('\n')}

REQUIREMENTS EXCERPT:
${truncate(input.requirements, 4_000)}

TECH SPEC EXCERPT:
${truncate(input.techSpec, 3_000)}

BA OUTPUT EXCERPT:
${truncate(input.baOutput, 3_000)}

QA OR BUILD FEEDBACK TO FIX:
${truncate(input.qaFeedback, 4_000)}

SCOPED REPAIR CONSTRAINTS:
${formatRepairScope(input.repairScope)}

EXISTING TARGET FILE CONTENTS:
${existingSections}
`;
}

function parseRawFileResponse(raw: string, expectedPath: string): GeneratedFile {
  const startMarker = 'FILE_CONTENT_START';
  const endMarker = 'FILE_CONTENT_END';
  const start = raw.indexOf(startMarker);
  const end = raw.lastIndexOf(endMarker);

  if (start < 0 || end <= start) {
    throw new Error('Raw file response did not include FILE_CONTENT_START and FILE_CONTENT_END markers.');
  }

  const pathMatch = raw.slice(0, start).match(/FILE_PATH:\s*(.+)/);
  const path = pathMatch?.[1]?.trim() || expectedPath;
  const content = raw.slice(start + startMarker.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');

  return GeneratedFileSchema.parse({ path, content });
}

function parseGeneratedFileBatchResponse(raw: string, expectedFiles: DevManifest['files']): GeneratedFile[] {
  const expectedPaths = expectedFiles.map((file) => file.path);
  const expectedSet = new Set(expectedPaths.map(normalizeGeneratedPath));
  const parsed = GeneratedFileBatchSchema.parse(extractJsonObject(raw));
  const fileMap = new Map(parsed.files.map((file) => [normalizeGeneratedPath(file.path), file]));
  const missing = expectedPaths.filter((filePath) => !fileMap.has(normalizeGeneratedPath(filePath)));
  const extras = parsed.files.filter((file) => !expectedSet.has(normalizeGeneratedPath(file.path))).map((file) => file.path);

  if (missing.length || extras.length) {
    throw new Error(`Generated batch path mismatch. Missing: ${missing.join(', ') || 'none'}. Extra: ${extras.join(', ') || 'none'}.`);
  }

  return expectedPaths.map((filePath) => GeneratedFileSchema.parse(fileMap.get(normalizeGeneratedPath(filePath))));
}

async function requestGeneratedFile(params: {
  input: {
    requirements: string;
    techSpec: string;
    baOutput: string;
    existingFiles?: GeneratedFile[];
    qaFeedback: string;
    repairScope?: RepairScope;
    onProgress?: RunProgressReporter;
  };
  manifest: DevManifest;
  manifestFile: DevManifest['files'][number];
}): Promise<GeneratedFile> {
  const batchContext = buildBatchFileContext({
    requirements: params.input.requirements,
    techSpec: params.input.techSpec,
    baOutput: params.input.baOutput,
    qaFeedback: params.input.qaFeedback,
    repairScope: params.input.repairScope,
    manifest: params.manifest,
    manifestFiles: [params.manifestFile],
    existingFiles: params.input.existingFiles
  });
  let lastRaw = '';
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const fileRaw = await runMarkdownSkillAgent({
        agentId: 'dev',
        fallbackTemperature: 0.1,
        maxTokens: attempt === 1 ? 20_000 : 32_768,
        jsonSchema: {
          name: 'generated_file',
          schema: GeneratedFileJsonSchema
        },
        userPrompt: `
Generate exactly one complete file. Return JSON only.

Return exactly this JSON shape:
{
  "path": "${params.manifestFile.path}",
  "content": "complete file content"
}

Rules:
- The path must be exactly ${params.manifestFile.path}.
- The content must be the full file content, not a snippet.
- Keep the file concise enough to fit in one response.
- Do not include markdown fences or commentary.
${attempt > 1 ? '- Previous response failed or was truncated. Return a smaller complete implementation for this file.' : ''}

${batchContext}
`
      });

      lastRaw = fileRaw;
      const parsed = GeneratedFileSchema.parse(extractJsonObject(fileRaw));
      if (normalizeGeneratedPath(parsed.path) !== normalizeGeneratedPath(params.manifestFile.path)) {
        throw new Error(`Generated file path mismatch. Expected ${params.manifestFile.path}, got ${parsed.path}.`);
      }

      return parsed;
    } catch (error) {
      lastError = error;
      await params.input.onProgress?.({
        stepId: 'dev',
        stepStatus: 'RUNNING',
        level: 'warn',
        message: `DEV retrying ${params.manifestFile.path}; ${isTruncationError(error) ? 'response was truncated' : 'provider returned invalid JSON'} on attempt ${attempt}.`
      });
    }
  }

  const rawFallback = await runMarkdownSkillAgent({
    agentId: 'dev',
    fallbackTemperature: 0.1,
    maxTokens: 32_768,
    userPrompt: `
Generate exactly one complete file using raw markers, not JSON.

Return exactly this shape:
FILE_PATH: ${params.manifestFile.path}
FILE_CONTENT_START
<complete file content>
FILE_CONTENT_END

Rules:
- Do not wrap the response in markdown.
- Do not add commentary before or after the markers.
- Keep the file concise enough to fit in one response.

${batchContext}

PREVIOUS INVALID RESPONSE EXCERPT:
${truncate(lastRaw || String(lastError), 1_000)}
`
  });

  const parsed = parseRawFileResponse(rawFallback, params.manifestFile.path);
  if (normalizeGeneratedPath(parsed.path) !== normalizeGeneratedPath(params.manifestFile.path)) {
    throw new Error(`Generated file path mismatch. Expected ${params.manifestFile.path}, got ${parsed.path}.`);
  }

  return parsed;
}

async function requestGeneratedFileBatch(params: {
  input: {
    requirements: string;
    techSpec: string;
    baOutput: string;
    existingFiles?: GeneratedFile[];
    qaFeedback: string;
    repairScope?: RepairScope;
    onProgress?: RunProgressReporter;
  };
  manifest: DevManifest;
  manifestFiles: DevManifest['files'];
}): Promise<GeneratedFile[]> {
  if (params.manifestFiles.length === 0) return [];
  if (params.manifestFiles.length === 1) {
    return [
      await requestGeneratedFile({
        input: params.input,
        manifest: params.manifest,
        manifestFile: params.manifestFiles[0]
      })
    ];
  }

  const paths = params.manifestFiles.map((file) => file.path);
  const batchContext = buildBatchFileContext({
    requirements: params.input.requirements,
    techSpec: params.input.techSpec,
    baOutput: params.input.baOutput,
    qaFeedback: params.input.qaFeedback,
    repairScope: params.input.repairScope,
    manifest: params.manifest,
    manifestFiles: params.manifestFiles,
    existingFiles: params.input.existingFiles
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const batchRaw = await runMarkdownSkillAgent({
        agentId: 'dev',
        fallbackTemperature: 0.1,
        maxTokens: 32_768,
        jsonSchema: {
          name: 'generated_file_batch',
          schema: GeneratedFileBatchJsonSchema
        },
        userPrompt: `
Generate a batch of complete files. Return JSON only.

Return exactly this JSON shape:
{
  "files": [
    { "path": "relative/path", "content": "complete file content" }
  ]
}

Rules:
- Return exactly these paths and no others: ${paths.join(', ')}
- Each content value must be the full file content, not a snippet.
- Keep files concise enough to fit in one response.
- Do not include markdown fences or commentary.
${attempt > 1 ? '- Previous batch response failed or was too large. Return shorter complete implementations for the same files.' : ''}

${batchContext}
`
      });

      return parseGeneratedFileBatchResponse(batchRaw, params.manifestFiles);
    } catch (error) {
      const truncated = isTruncationError(error);
      await params.input.onProgress?.({
        stepId: 'dev',
        stepStatus: 'RUNNING',
        level: 'warn',
        message: truncated
          ? `DEV batch response was truncated for ${paths.join(', ')}; splitting into smaller batches.`
          : `DEV retrying batch ${paths.join(', ')}; provider returned invalid JSON on attempt ${attempt}.`
      });

      if (truncated) break;
    }
  }

  const midpoint = Math.ceil(params.manifestFiles.length / 2);
  const left = params.manifestFiles.slice(0, midpoint);
  const right = params.manifestFiles.slice(midpoint);
  await params.input.onProgress?.({
    stepId: 'dev',
    stepStatus: 'RUNNING',
    level: 'warn',
    message: `DEV splitting batch into ${left.length} + ${right.length} file(s) after batch failure.`
  });

  return [
    ...(await requestGeneratedFileBatch({ ...params, manifestFiles: left })),
    ...(await requestGeneratedFileBatch({ ...params, manifestFiles: right }))
  ];
}

export async function runDevAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  previousDevOutput?: DevOutput;
  qaFeedback?: string;
  repairScope?: RepairScope;
  apiSpec?: string;
  onProgress?: RunProgressReporter;
}): Promise<DevOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCode = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const previousDevOutput = formatPreviousDevOutput(input.previousDevOutput);
  const qaFeedback = input.qaFeedback?.trim() || 'No QA feedback yet.';
  const devContext = buildDevContext({
    requirements: input.requirements,
    techSpec,
    baOutput: input.baOutput,
    existingCode,
    previousDevOutput,
    runHistoryContext,
    qaFeedback,
    repairScope: input.repairScope,
    apiSpec: input.apiSpec
  });

  let manifest: DevManifest;
  if (input.repairScope && !input.repairScope.requiresPlanning && input.repairScope.candidatePaths.length > 0) {
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      message: `DEV using dynamic scoped repair manifest without an extra planning call: ${input.repairScope.label}.`
    });
    manifest = buildScopedRepairManifest({
      repairScope: input.repairScope,
      qaFeedback,
      previousDevOutput: input.previousDevOutput
    });
  } else {
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      message: input.repairScope ? `DEV requesting dynamic scoped repair manifest from OpenRouter: ${input.repairScope.label}.` : 'DEV requesting implementation manifest from OpenRouter.'
    });
    manifest = await requestDevManifest({
      devContext,
      repairScope: input.repairScope,
      onProgress: input.onProgress
    });
  }

  manifest = applyRepairScopeToManifest(manifest, input.repairScope);
  await input.onProgress?.({
    stepId: 'dev',
    stepStatus: 'RUNNING',
    level: 'success',
    message: input.repairScope
      ? `DEV scoped repair manifest planned ${manifest.files.length} file(s) for ${input.repairScope.label}.`
      : `DEV manifest planned ${manifest.files.length} files.`
  });

  const files: GeneratedFile[] = [];
  const batchSize = input.repairScope && manifest.files.length <= 2 ? manifest.files.length || 1 : getDevFileBatchSize();
  for (let index = 0; index < manifest.files.length; index += batchSize) {
    const batch = manifest.files.slice(index, index + batchSize);
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      message:
        batch.length === 1
          ? `DEV generating file ${index + 1}/${manifest.files.length}: ${batch[0].path}`
          : `DEV generating files ${index + 1}-${index + batch.length}/${manifest.files.length}: ${batch.map((file) => file.path).join(', ')}`
    });

    const batchFiles = await requestGeneratedFileBatch({
      input: {
        requirements: input.requirements,
        techSpec,
        baOutput: input.baOutput,
        existingFiles: input.existingFiles,
        qaFeedback,
        repairScope: input.repairScope,
        onProgress: input.onProgress
      },
      manifest,
      manifestFiles: batch
    });

    for (const file of batchFiles) {
      files.push(file);
      await input.onProgress?.({
        stepId: 'dev',
        stepStatus: 'RUNNING',
        level: 'success',
        message: `DEV generated ${file.path}.`
      });
    }
  }

  await input.onProgress?.({ stepId: 'dev', stepStatus: 'PASS', level: 'success', message: 'DEV generated all planned files.' });
  return DevOutputSchema.parse({
    architecture: manifest.architecture,
    files,
    setupInstructions: manifest.setupInstructions
  });
}
