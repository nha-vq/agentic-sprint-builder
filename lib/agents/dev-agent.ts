import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatGeneratedProjectOverview, formatRunHistoryContext } from '@/lib/context/agent-context';
import { RUN_LIMITS } from '@/lib/config/limits';
import { extractJsonObject } from '@/lib/utils/json';
import { formatRepairScope } from '@/lib/validation/repair-scope';
import type { ProjectDevSkill } from '@/lib/skills/project-dev-skill';
import type { AgentId, DashboardEventType, DevOutput, FreeImageCandidate, GeneratedFile, PreparedTechStackOutput, RepairScope, RequirementImage, RunProgressReporter, RunResult } from '@/lib/types';

type DevWorkerAgentId = Extract<AgentId, 'dev' | 'frontend-dev' | 'backend-dev' | 'integration-dev'>;

type DevAgentActivityReporter = (activity: {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  artifact?: string;
}) => void | Promise<void>;

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

class OversizedGeneratedFileError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly bytes: number,
    public readonly limit: number
  ) {
    super(`Generated file ${filePath} is ${bytes} bytes, exceeding ${limit} bytes.`);
  }
}

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
    content: { type: 'string', maxLength: RUN_LIMITS.generatedFileBytes }
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

function formatRequirementImageContext(images?: RequirementImage[] | null) {
  if (!images?.length) {
    return 'No requirement images are attached.';
  }

  const imageList = images
    .map((image, index) => `- Image ${index + 1}: ${image.name} (${image.mimeType}, ${Math.round(image.sizeBytes / 1024)} KB)`)
    .join('\n');

  return `Attached requirement images are available to this DEV request as visual source material.
${imageList}

Use these images together with the BA Frontend Visual Design Contract. For frontend visual files, inspect the attached images directly before deciding layout, styling, component composition, product imagery treatment, spacing, typography, and responsive behavior. Reproduce visible in-scope UI and static placeholders needed for visual fidelity, but do not add backend workflows for out-of-scope mockup features.`;
}

function formatFreeImageCandidateContext(candidates?: FreeImageCandidate[] | null) {
  if (!candidates?.length) {
    return 'No free/safe remote image candidates were provided. Use neutral CSS or local placeholder treatment instead of unsafe hotlinks.';
  }

  const imageList = candidates
    .map((candidate, index) => {
      const thumb = candidate.thumbUrl ? `\n  Thumb: ${candidate.thumbUrl}` : '';
      const licenseUrl = candidate.licenseUrl ? `\n  License URL: ${candidate.licenseUrl}` : '';
      return `${index + 1}. ${candidate.title}
  Query: ${candidate.query}
  Image URL: ${candidate.imageUrl}
  Source page: ${candidate.pageUrl}
  License: ${candidate.license}${licenseUrl}${thumb}`;
    })
    .join('\n');

  return `Free/safe remote image candidates are available for generated product/media imagery.
Use only candidates that fit the BA Frontend Visual Design Contract and the mockup subject/style. Prefer the direct Image URL for display and include source/license notes in README Visual Fidelity Notes. Do not use unrelated imagery just because it is available.
${imageList}`;
}

function hasRequirementImages(images?: RequirementImage[] | null) {
  return (images?.length ?? 0) > 0;
}

function isFrontendVisualPath(filePath: string) {
  const normalized = normalizeGeneratedPath(filePath);
  return (
    normalized.startsWith('frontend/') &&
    (/\.(tsx|jsx|ts|js|css|scss|sass|html)$/.test(normalized) ||
      /(^|\/)(tailwind|postcss|next|vite)\.config\.(js|ts|mjs|cjs)$/.test(normalized) ||
      /(^|\/)(package\.json|tsconfig\.json|jsconfig\.json)$/.test(normalized))
  );
}

function imagesForFrontendTargets(images: RequirementImage[] | undefined, manifestFiles: DevManifest['files']) {
  if (!images?.length) return undefined;
  return manifestFiles.some((file) => isFrontendVisualPath(file.path)) ? images : undefined;
}

function isTruncationError(error: unknown) {
  return error instanceof Error && /truncated|finish_reason.*length|max_tokens|incomplete json|started a json object but did not finish/i.test(error.message);
}

function isOversizedGeneratedFileError(error: unknown): error is OversizedGeneratedFileError {
  return error instanceof OversizedGeneratedFileError;
}

function fileSizeLimitInstruction() {
  return `Each generated file content must stay under ${RUN_LIMITS.generatedFileBytes} bytes. Do not generate package lockfiles, vendored dependencies, build outputs, binary/base64 assets, screenshots, huge fixtures, or massive seed datasets. Use concise seed samples and document install/generation commands instead.`;
}

function generatedFileByteSize(file: Pick<GeneratedFile, 'content'>) {
  return Buffer.byteLength(file.content, 'utf8');
}

function assertGeneratedFileWithinLimit(file: GeneratedFile): GeneratedFile {
  const bytes = generatedFileByteSize(file);
  if (bytes > RUN_LIMITS.generatedFileBytes) {
    throw new OversizedGeneratedFileError(file.path, bytes, RUN_LIMITS.generatedFileBytes);
  }

  return file;
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

function devWorkerLabel(agentId: DevWorkerAgentId) {
  if (agentId === 'frontend-dev') return 'Frontend DEV';
  if (agentId === 'backend-dev') return 'Backend DEV';
  if (agentId === 'integration-dev') return 'Integration DEV';
  return 'DEV Lead';
}

function devWorkerForPath(filePath: string): DevWorkerAgentId {
  const normalized = normalizeGeneratedPath(filePath);
  const name = basename(normalized);

  if (
    name === 'dockerfile' ||
    name === 'containerfile' ||
    /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(normalized) ||
    /(^|\/)(\.env\.example|\.env|readme\.md)$/i.test(normalized) ||
    /(^|\/)(next|vite|webpack|turbo|postcss|tailwind)\.config\.(js|ts|mjs|cjs)$/i.test(normalized)
  ) {
    return 'integration-dev';
  }

  if (normalized.startsWith('frontend/')) return 'frontend-dev';

  if (
    normalized.startsWith('backend/') ||
    normalized.startsWith('database/') ||
    normalized.startsWith('db/') ||
    /(^|\/)(migrations?|schema|seed|initdb)\//i.test(normalized)
  ) {
    return 'backend-dev';
  }

  return 'integration-dev';
}

function modelForDevWorker(agentId: DevWorkerAgentId, input: { modelOverride?: string; agentModelOverrides?: Partial<Record<AgentId, string>> }) {
  return input.agentModelOverrides?.[agentId] || (agentId === 'dev' ? input.modelOverride : undefined) || input.modelOverride;
}

function workerSystemAppend(agentId: DevWorkerAgentId, baseAppend: string) {
  const role =
    agentId === 'frontend-dev'
      ? `## Current Worker Role
You are the Frontend DEV. Own only frontend application files, shared UI components, styling, browser-side API calls, visual fidelity, responsive layout, and client/server component correctness. In App Router projects, any component that imports client-only UI libraries such as react-icons, uses hooks, browser APIs, event handlers, or next/navigation client hooks must begin with 'use client'. Never import next/document from app/ files or components.`
      : agentId === 'backend-dev'
      ? `## Current Worker Role
You are the Backend DEV. Own only backend API files, data models, persistence, validation, seed data, CORS, health checks, and backend dependency/runtime files. Keep API response shapes aligned with the frontend contract and seed enough representative data for local smoke testing.`
      : agentId === 'integration-dev'
      ? `## Current Worker Role
You are the Integration DEV. Own Dockerfiles, Compose, env examples, README run instructions, service wiring, ports, health checks, and frontend/backend integration contracts. Every Dockerfile COPY source must exist inside that build stage/context. Do not copy /app/public unless a public directory is generated. Browser-facing API URLs must be reachable from the browser, not only from Compose service DNS.`
      : `## Current Worker Role
You are the DEV Lead. Own implementation planning, file ownership, architecture consistency, and final integration across specialized DEV workers.`;

  return [baseAppend, role].filter(Boolean).join('\n\n');
}

function buildWorkerBatches(manifestFiles: DevManifest['files'], batchSize: number) {
  const batches: Array<{ agentId: DevWorkerAgentId; files: DevManifest['files'] }> = [];

  for (const file of manifestFiles) {
    const agentId = devWorkerForPath(file.path);
    const lastBatch = batches[batches.length - 1];
    if (lastBatch && lastBatch.agentId === agentId && lastBatch.files.length < batchSize) {
      lastBatch.files.push(file);
    } else {
      batches.push({ agentId, files: [file] });
    }
  }

  return batches;
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

function mergeWithExistingFiles(generatedFiles: GeneratedFile[], existingFiles?: GeneratedFile[]) {
  if (!existingFiles?.length) return generatedFiles;

  const merged = new Map(existingFiles.map((file) => [normalizeGeneratedPath(file.path), file]));
  for (const file of generatedFiles) {
    merged.set(normalizeGeneratedPath(file.path), file);
  }

  return Array.from(merged.values());
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

function buildDevSystemAppend(params: {
  projectDevSkill?: ProjectDevSkill | null;
  preparedTechStack?: PreparedTechStackOutput;
  enrichedSkillContext?: string;
}) {
  const parts: string[] = [];
  if (params.enrichedSkillContext?.trim()) parts.push(params.enrichedSkillContext.trim());
  if (params.projectDevSkill?.body?.trim()) parts.push(params.projectDevSkill.body.trim());
  if (params.preparedTechStack) {
    parts.push(`## Prepared Tech Stack Runtime Context
This context was produced by the prepare-tech-stack skill after BA analysis. Treat it as the source of truth for stack choices unless explicit user requirements conflict with it.

\`\`\`json
${JSON.stringify(params.preparedTechStack, null, 2)}
\`\`\``);
  }

  return parts.join('\n\n');
}

function selectScopedRepairPaths(params: {
  repairScope: RepairScope;
  qaFeedback: string;
}) {
  const candidates = orderedUnique(params.repairScope.candidatePaths);
  const text = params.qaFeedback.toLowerCase();

  if (params.repairScope.kind === 'docker') {
    const containerFiles = candidates.filter((filePath) => /(^|\/)(dockerfile|containerfile|(compose|docker-compose)\.ya?ml)$/i.test(filePath));
    const scored = containerFiles
      .map((filePath) => {
        const normalized = normalizeGeneratedPath(filePath);
        let score = 0;
        if (text.includes(normalized)) score += 100;
        if (/docker-compose\.ya?ml|compose\.ya?ml/.test(normalized) && /docker-compose\.ya?ml|compose\.ya?ml|compose/.test(text)) score += 80;
        if (normalized.includes('/frontend/') && /frontend/i.test(text)) score += 40;
        if (normalized.includes('/backend/') && /backend/i.test(text)) score += 40;
        if (text.includes(basename(filePath))) score += 20;
        return { filePath, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    if (scored.length > 0) return scored.map((item) => item.filePath).slice(0, 4);
    if (containerFiles.length > 0) return containerFiles.slice(0, 4);
  }

  const referenced = candidates.filter((filePath) => text.includes(normalizeGeneratedPath(filePath)) || text.includes(basename(filePath)));

  if (referenced.length > 0) return referenced.slice(0, 6);

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
  if (filteredFiles.length > 0) {
    return {
      ...manifest,
      files: filteredFiles.slice(0, repairScope.requiresPlanning ? 8 : 6)
    };
  }

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
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedTechStack?: PreparedTechStackOutput;
  baOutput: string;
  existingCode: string;
  projectOverview: string;
  projectDevSkillStatus: string;
  hasProjectDevSkill: boolean;
  previousDevOutput: string;
  runHistoryContext: string;
  qaFeedback: string;
  repairScope?: RepairScope;
  apiSpec?: string;
}) {
  const repairContext = input.repairScope
    ? `
REPAIR CONTEXT:
QA or build feedback is present. Follow the repair rules in the loaded DEV skill, use the generated project overview as evidence, and choose the smallest file set that can address the reported failure.
`
    : '';

  return `
Use the loaded DEV skill as the source of generation behavior, architecture rules, technology defaults, validation expectations, and repair rules.
Application source only provides context and output-format constraints.
If no project-specific skill is loaded, use the overall DEV skill for first generation.
If existing generated code is provided, update that project according to the loaded skill and current request.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${input.techSpec}

REQUIREMENT IMAGE CONTEXT:
${formatRequirementImageContext(input.requirementImages)}

FREE/SAFE IMAGE CANDIDATES:
${formatFreeImageCandidateContext(input.freeImageCandidates)}

PREPARED TECH STACK (SOURCE OF TRUTH WHEN PRESENT):
${input.preparedTechStack ? JSON.stringify(input.preparedTechStack, null, 2) : 'Not prepared. If this is first generation, report this as a workflow issue and use safe skill defaults only when instructed by the orchestrator.'}

BA OUTPUT:
${input.baOutput}

EXISTING GENERATED CODE:
${input.existingCode}

GENERATED PROJECT OVERVIEW:
${input.projectOverview}

PROJECT-SPECIFIC DEV SKILL STATUS:
${input.projectDevSkillStatus}

PREVIOUS DEV OUTPUT SUMMARY:
${input.previousDevOutput}

RECENT RUN HISTORY:
${input.runHistoryContext}

QA OR BUILD FEEDBACK TO FIX:
${input.qaFeedback}

${repairContext}

SCOPED REPAIR CONSTRAINTS:
${formatRepairScope(input.repairScope)}

DASHBOARD API SPEC:
${input.apiSpec || 'Not provided'}
`;
}

async function requestDevManifest(params: {
  devContext: string;
  requirementImages?: RequirementImage[];
  projectDevSkill?: ProjectDevSkill | null;
  preparedTechStack?: PreparedTechStackOutput;
  enrichedSkillContext?: string;
  modelOverride?: string;
  repairScope?: RepairScope;
  onProgress?: RunProgressReporter;
  signal?: AbortSignal;
}) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const manifestRaw = await runMarkdownSkillAgent({
        agentId: 'dev',
        modelOverride: params.modelOverride,
        fallbackTemperature: 0.1,
        maxTokens: attempt === 1 ? 8_192 : 12_288,
        systemAppend: buildDevSystemAppend({
          projectDevSkill: params.projectDevSkill,
          preparedTechStack: params.preparedTechStack,
          enrichedSkillContext: params.enrichedSkillContext
        }),
        jsonSchema: {
          name: 'dev_manifest',
          schema: DevManifestJsonSchema
        },
        signal: params.signal,
        images: hasRequirementImages(params.requirementImages) ? params.requirementImages : undefined,
        userPrompt: `
Plan the implementation. Return JSON only.

Return a compact manifest only: architecture, setupInstructions, and files with path + purpose.
Do not include file content in this response.
Keep setupInstructions concise. Avoid markdown lists inside JSON strings.
Do not plan package lockfiles, vendored dependencies, build outputs, binary/base64 assets, screenshots, huge fixtures, or massive seed datasets unless explicitly required.
Plan all files required by the loaded DEV skill, BA output, requirements, tech spec, and any repair scope.
The file list must be complete enough for the generated project to satisfy the loaded skill and local validation.
If requirement images are attached, include the frontend page, component, style/theme, layout, and seed-media files needed to implement the BA Frontend Visual Design Contract rather than a generic scaffold.
${attempt > 1 ? 'Previous manifest response failed or was truncated. Return shorter valid JSON only.' : ''}
${params.repairScope ? 'This is a scoped incremental repair. Use QA OR BUILD FEEDBACK, GENERATED PROJECT OVERVIEW, and SCOPED REPAIR CONSTRAINTS to select the smallest useful file set allowed by the loaded DEV skill.' : ''}

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
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedTechStack?: PreparedTechStackOutput;
  baOutput: string;
  qaFeedback: string;
  repairScope?: RepairScope;
  manifest: DevManifest;
  manifestFiles: DevManifest['files'];
  existingFiles?: GeneratedFile[];
}) {
  const projectOverview = formatGeneratedProjectOverview(input.existingFiles ?? []);
  const existingSections = input.manifestFiles
    .map((manifestFile) => {
      const existingContent = findExistingFile(input.existingFiles, manifestFile.path)?.content;
      return `## ${manifestFile.path}\n${existingContent ? truncate(existingContent, 4_000) : 'No existing file content for this target path.'}`;
    })
    .join('\n\n');

  return `
PROJECT CONTRACT:
- Generate complete, runnable files for the target paths only.
- Use the loaded DEV skill as the source of all generation rules and architecture requirements.
- Use BA OUTPUT, requirements, tech spec, the manifest, and any repair feedback to decide the actual file content.
- If this is a repair, preserve unrelated existing generated files and only change content needed for the scoped target file.
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

GENERATED PROJECT OVERVIEW:
${projectOverview}

REQUIREMENTS EXCERPT:
${truncate(input.requirements, 4_000)}

TECH SPEC EXCERPT:
${truncate(input.techSpec, 3_000)}

REQUIREMENT IMAGE CONTEXT:
${formatRequirementImageContext(input.requirementImages)}

FREE/SAFE IMAGE CANDIDATES:
${formatFreeImageCandidateContext(input.freeImageCandidates)}

PREPARED TECH STACK EXCERPT:
${input.preparedTechStack ? truncate(JSON.stringify(input.preparedTechStack, null, 2), 6_000) : 'Not prepared.'}

BA OUTPUT EXCERPT:
${truncate(input.baOutput, 6_000)}

QA OR BUILD FEEDBACK TO FIX:
${truncate(input.qaFeedback, 16_000)}

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

  return assertGeneratedFileWithinLimit(GeneratedFileSchema.parse({ path, content }));
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

  return expectedPaths.map((filePath) => assertGeneratedFileWithinLimit(GeneratedFileSchema.parse(fileMap.get(normalizeGeneratedPath(filePath)))));
}

async function requestGeneratedFile(params: {
  input: {
    requirements: string;
    techSpec: string;
    requirementImages?: RequirementImage[];
    freeImageCandidates?: FreeImageCandidate[];
    preparedTechStack?: PreparedTechStackOutput;
    baOutput: string;
    existingFiles?: GeneratedFile[];
    qaFeedback: string;
    repairScope?: RepairScope;
    projectDevSkill?: ProjectDevSkill | null;
    enrichedSkillContext?: string;
    modelOverride?: string;
    agentModelOverrides?: Partial<Record<AgentId, string>>;
    workerAgentId?: DevWorkerAgentId;
    onProgress?: RunProgressReporter;
    signal?: AbortSignal;
  };
  manifest: DevManifest;
  manifestFile: DevManifest['files'][number];
}): Promise<GeneratedFile> {
  const attachedImages = isFrontendVisualPath(params.manifestFile.path) && hasRequirementImages(params.input.requirementImages) ? params.input.requirementImages : undefined;
  const batchContext = buildBatchFileContext({
    requirements: params.input.requirements,
    techSpec: params.input.techSpec,
    requirementImages: attachedImages,
    freeImageCandidates: params.input.freeImageCandidates,
    preparedTechStack: params.input.preparedTechStack,
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
        agentId: params.input.workerAgentId || 'dev',
        modelOverride: modelForDevWorker(params.input.workerAgentId || 'dev', params.input),
        fallbackTemperature: 0.1,
        maxTokens: attempt === 1 ? 32_768 : 65_536,
        systemAppend: workerSystemAppend(
          params.input.workerAgentId || 'dev',
          buildDevSystemAppend({
            projectDevSkill: params.input.projectDevSkill,
            preparedTechStack: params.input.preparedTechStack,
            enrichedSkillContext: params.input.enrichedSkillContext
          })
        ),
        jsonSchema: {
          name: 'generated_file',
          schema: GeneratedFileJsonSchema
        },
        signal: params.input.signal,
        images: attachedImages,
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
- ${fileSizeLimitInstruction()}
- Do not include markdown fences or commentary.
- If requirement images are attached to this request, inspect them directly and implement the visible mockup-driven layout/style details for the target frontend file.
${attempt > 1 ? '- Previous response failed, was truncated, or exceeded the file-size limit. Return a smaller complete implementation for this file.' : ''}

${batchContext}
`
      });

      lastRaw = fileRaw;
      const parsed = GeneratedFileSchema.parse(extractJsonObject(fileRaw));
      if (normalizeGeneratedPath(parsed.path) !== normalizeGeneratedPath(params.manifestFile.path)) {
        throw new Error(`Generated file path mismatch. Expected ${params.manifestFile.path}, got ${parsed.path}.`);
      }

      return assertGeneratedFileWithinLimit(parsed);
    } catch (error) {
      lastError = error;
      const oversized = isOversizedGeneratedFileError(error);
      const workerAgentId = params.input.workerAgentId || 'dev';
      const workerLabel = devWorkerLabel(workerAgentId);
      await params.input.onProgress?.({
        stepId: workerAgentId,
        stepStatus: 'RUNNING',
        level: 'warn',
        message: oversized
          ? `${workerLabel} retrying ${params.manifestFile.path}; generated file was too large (${error.bytes}/${error.limit} bytes) on attempt ${attempt}.`
          : `${workerLabel} retrying ${params.manifestFile.path}; ${isTruncationError(error) ? 'response was truncated' : 'provider returned invalid JSON'} on attempt ${attempt}.`
      });
    }
  }

  const rawFallback = await runMarkdownSkillAgent({
    agentId: params.input.workerAgentId || 'dev',
    modelOverride: modelForDevWorker(params.input.workerAgentId || 'dev', params.input),
    fallbackTemperature: 0.1,
    maxTokens: 65_536,
    systemAppend: workerSystemAppend(
      params.input.workerAgentId || 'dev',
      buildDevSystemAppend({
        projectDevSkill: params.input.projectDevSkill,
        preparedTechStack: params.input.preparedTechStack,
        enrichedSkillContext: params.input.enrichedSkillContext
      })
    ),
    signal: params.input.signal,
    images: attachedImages,
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
- ${fileSizeLimitInstruction()}
- If requirement images are attached to this request, inspect them directly and implement the visible mockup-driven layout/style details for this frontend file.

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
    requirementImages?: RequirementImage[];
    freeImageCandidates?: FreeImageCandidate[];
    preparedTechStack?: PreparedTechStackOutput;
    baOutput: string;
    existingFiles?: GeneratedFile[];
    qaFeedback: string;
    repairScope?: RepairScope;
    projectDevSkill?: ProjectDevSkill | null;
    enrichedSkillContext?: string;
    modelOverride?: string;
    agentModelOverrides?: Partial<Record<AgentId, string>>;
    workerAgentId?: DevWorkerAgentId;
    onProgress?: RunProgressReporter;
    signal?: AbortSignal;
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
  const attachedImages = imagesForFrontendTargets(params.input.requirementImages, params.manifestFiles);
  const batchContext = buildBatchFileContext({
    requirements: params.input.requirements,
    techSpec: params.input.techSpec,
    requirementImages: attachedImages,
    freeImageCandidates: params.input.freeImageCandidates,
    preparedTechStack: params.input.preparedTechStack,
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
        agentId: params.input.workerAgentId || 'dev',
        modelOverride: modelForDevWorker(params.input.workerAgentId || 'dev', params.input),
        fallbackTemperature: 0.1,
        maxTokens: 65_536,
        systemAppend: workerSystemAppend(
          params.input.workerAgentId || 'dev',
          buildDevSystemAppend({
            projectDevSkill: params.input.projectDevSkill,
            preparedTechStack: params.input.preparedTechStack,
            enrichedSkillContext: params.input.enrichedSkillContext
          })
        ),
        jsonSchema: {
          name: 'generated_file_batch',
          schema: GeneratedFileBatchJsonSchema
        },
        signal: params.input.signal,
        images: attachedImages,
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
- ${fileSizeLimitInstruction()}
- Do not include markdown fences or commentary.
- If requirement images are attached to this request, inspect them directly and implement the visible mockup-driven layout/style details for the target frontend files.
${attempt > 1 ? '- Previous batch response failed, was truncated, or exceeded the file-size limit. Return shorter complete implementations for the same files.' : ''}

${batchContext}
`
      });

      return parseGeneratedFileBatchResponse(batchRaw, params.manifestFiles);
    } catch (error) {
      const truncated = isTruncationError(error);
      const oversized = isOversizedGeneratedFileError(error);
      const workerAgentId = params.input.workerAgentId || 'dev';
      const workerLabel = devWorkerLabel(workerAgentId);
      await params.input.onProgress?.({
        stepId: workerAgentId,
        stepStatus: 'RUNNING',
        level: 'warn',
        message: oversized
          ? `${workerLabel} batch produced oversized ${error.filePath} (${error.bytes}/${error.limit} bytes); splitting into smaller batches.`
          : truncated
          ? `${workerLabel} batch response was truncated for ${paths.join(', ')}; splitting into smaller batches.`
          : `${workerLabel} retrying batch ${paths.join(', ')}; provider returned invalid JSON on attempt ${attempt}.`
      });

      if (truncated || oversized) break;
    }
  }

  const midpoint = Math.ceil(params.manifestFiles.length / 2);
  const left = params.manifestFiles.slice(0, midpoint);
  const right = params.manifestFiles.slice(midpoint);
  const workerAgentId = params.input.workerAgentId || 'dev';
  await params.input.onProgress?.({
    stepId: workerAgentId,
    stepStatus: 'RUNNING',
    level: 'warn',
    message: `${devWorkerLabel(workerAgentId)} splitting batch into ${left.length} + ${right.length} file(s) after batch failure.`
  });

  return [
    ...(await requestGeneratedFileBatch({ ...params, manifestFiles: left })),
    ...(await requestGeneratedFileBatch({ ...params, manifestFiles: right }))
  ];
}

export async function runDevAgent(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedTechStack?: PreparedTechStackOutput;
  baOutput: string;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  previousDevOutput?: DevOutput;
  qaFeedback?: string;
  repairScope?: RepairScope;
  projectDevSkill?: ProjectDevSkill | null;
  enrichedSkillContext?: string;
  modelOverride?: string;
  agentModelOverrides?: Partial<Record<AgentId, string>>;
  apiSpec?: string;
  onProgress?: RunProgressReporter;
  onAgentActivity?: DevAgentActivityReporter;
  signal?: AbortSignal;
}): Promise<DevOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCode = formatGeneratedCodeContext(input.existingFiles ?? []);
  const projectOverview = formatGeneratedProjectOverview(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const previousDevOutput = formatPreviousDevOutput(input.previousDevOutput);
  const qaFeedback = input.qaFeedback?.trim() || 'No QA feedback yet.';
  const projectDevSkillStatus = input.projectDevSkill
    ? `Loaded project-specific dev skill for ${input.projectDevSkill.projectId} from ${input.projectDevSkill.path}. Use it to preserve stack, structure, commands, routes, env vars, and implemented features.`
    : 'No project-specific dev skill is loaded. Use the overall DEV skill for first scaffold generation.';

  await input.onProgress?.({
    stepId: 'dev',
    stepStatus: 'RUNNING',
    level: 'info',
    message: input.projectDevSkill ? `DEV using project-specific skill: ${input.projectDevSkill.path}` : 'DEV using overall dev skill; no project-specific skill exists yet.'
  });

  if (input.requirementImages?.length) {
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `DEV received ${input.requirementImages.length} requirement image(s); visual frontend files will include the images directly.`
    });
  }

  if (input.freeImageCandidates?.length) {
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `DEV received ${input.freeImageCandidates.length} free/safe image candidate(s) for generated product imagery.`
    });
  }

  if (input.repairScope && (input.existingFiles?.length ?? 0) > 0) {
    await input.onProgress?.({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      message: `DEV prepared generated project overview from ${input.existingFiles?.length ?? 0} file(s) before repair.`
    });
  }

  const devContext = buildDevContext({
    requirements: input.requirements,
    techSpec,
    requirementImages: input.requirementImages,
    freeImageCandidates: input.freeImageCandidates,
    preparedTechStack: input.preparedTechStack,
    baOutput: input.baOutput,
    existingCode,
    projectOverview,
    projectDevSkillStatus,
    hasProjectDevSkill: input.projectDevSkill !== null && input.projectDevSkill !== undefined,
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
      requirementImages: input.requirementImages ?? undefined,
      repairScope: input.repairScope,
      onProgress: input.onProgress,
      projectDevSkill: input.projectDevSkill,
      preparedTechStack: input.preparedTechStack,
      enrichedSkillContext: input.enrichedSkillContext,
      modelOverride: input.agentModelOverrides?.dev || input.modelOverride,
      signal: input.signal
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
  const workerBatches = buildWorkerBatches(manifest.files, batchSize);
  const usedWorkers = new Set<DevWorkerAgentId>();
  let generatedCount = 0;

  for (const workerBatch of workerBatches) {
    const batch = workerBatch.files;
    const workerLabel = devWorkerLabel(workerBatch.agentId);
    usedWorkers.add(workerBatch.agentId);
    await input.onAgentActivity?.({
      agentId: workerBatch.agentId,
      eventType: 'CODING',
      task: `${workerLabel} generating ${batch.length} owned file(s)`,
      toAgent: 'dev',
      artifact: 'generated-files'
    });
    await input.onProgress?.({
      stepId: workerBatch.agentId,
      stepStatus: 'RUNNING',
      message:
        batch.length === 1
          ? `${workerLabel} generating file ${generatedCount + 1}/${manifest.files.length}: ${batch[0].path}`
          : `${workerLabel} generating files ${generatedCount + 1}-${generatedCount + batch.length}/${manifest.files.length}: ${batch.map((file) => file.path).join(', ')}`
    });

    const batchFiles = await requestGeneratedFileBatch({
      input: {
        requirements: input.requirements,
        techSpec,
        requirementImages: input.requirementImages ?? undefined,
        freeImageCandidates: input.freeImageCandidates ?? undefined,
        preparedTechStack: input.preparedTechStack,
        baOutput: input.baOutput,
        existingFiles: input.existingFiles,
        qaFeedback,
        repairScope: input.repairScope,
        projectDevSkill: input.projectDevSkill,
        enrichedSkillContext: input.enrichedSkillContext,
        modelOverride: input.modelOverride,
        agentModelOverrides: input.agentModelOverrides,
        workerAgentId: workerBatch.agentId,
        onProgress: input.onProgress,
        signal: input.signal
      },
      manifest,
      manifestFiles: batch
    });

    for (const file of batchFiles) {
      files.push(file);
      generatedCount += 1;
      await input.onProgress?.({
        stepId: workerBatch.agentId,
        stepStatus: 'RUNNING',
        level: 'success',
        message: `${workerLabel} generated ${file.path}.`
      });
    }
  }

  for (const workerAgentId of Array.from(usedWorkers)) {
    await input.onProgress?.({
      stepId: workerAgentId,
      stepStatus: 'PASS',
      level: 'success',
      message: `${devWorkerLabel(workerAgentId)} completed owned file generation.`
    });
    await input.onAgentActivity?.({
      agentId: workerAgentId,
      eventType: 'WORK_COMPLETE',
      task: `${devWorkerLabel(workerAgentId)} completed owned file generation`,
      toAgent: 'dev',
      artifact: 'generated-files'
    });
  }

  await input.onProgress?.({ stepId: 'dev', stepStatus: 'PASS', level: 'success', message: 'DEV lead integrated all planned files.' });
  const outputFiles = input.repairScope ? mergeWithExistingFiles(files, input.existingFiles) : files;
  return DevOutputSchema.parse({
    architecture: manifest.architecture,
    files: outputFiles,
    setupInstructions: manifest.setupInstructions
  });
}
