import fs from 'fs/promises';
import path from 'path';
import { formatGeneratedProjectOverview } from '@/lib/context/agent-context';
import { parseSkillMarkdown, type LoadedSkill } from '@/lib/skills/loadSkill';
import type { DevOutput, GeneratedExecutionValidationResult, GeneratedFile, PreparedTechStackOutput, QAReviewOutput, UXContractOutput } from '@/lib/types';

export const DEFAULT_PROJECT_ID = 'generated-code';

const MAX_SKILL_SECTION_CHARS = 6_000;
const MAX_BA_EXCERPT_CHARS = 4_000;
const MAX_REQUIREMENTS_EXCERPT_CHARS = 4_000;
const MAX_VISUAL_CONTRACT_CHARS = 8_000;
const MAX_LEARNING_MEMORY_CHARS = 8_000;
const PROJECT_DEV_CONTEXT_FILENAME = 'ta-dev-context.md';
const LEGACY_PROJECT_DEV_SKILL_FILENAME = 'dev.md';

export interface ProjectDevSkill extends LoadedSkill {
  projectId: string;
  path: string;
}

export interface ProjectDevSkillWriteInput {
  projectId?: string;
  requirements: string;
  techSpec?: string | null;
  preparedTechStack?: PreparedTechStackOutput;
  uxContract?: UXContractOutput;
  baOutput: string;
  devOutput: DevOutput;
  executionValidation?: GeneratedExecutionValidationResult;
  qaReview?: QAReviewOutput;
  learningNotes?: string[];
  reason: string;
}

export interface ProjectDevSkillValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(markdown: string, heading: string) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = new RegExp(`^\\s*(?:#{1,6}\\s+|\\d+\\.\\s*)${escapeRegExp(heading)}\\s*$`, 'i');
  const nextSectionPattern = /^\s*(?:#{1,6}\s+|\d+\.\s*)[A-Z][^\n]*$/;
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextSectionPattern.test(lines[index])) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n').trim();
}

function extractMarkdownSectionBody(markdown: string, heading: string) {
  const section = extractMarkdownSection(markdown, heading);
  if (!section) return '';
  return section.split(/\r?\n/).slice(1).join('\n').trim();
}

function visualContractExcerpt(baOutput: string) {
  const section = extractMarkdownSection(baOutput, 'Frontend Visual Design Contract');
  if (!section) {
    return 'No dedicated Frontend Visual Design Contract section was found in the latest BA output. If requirement images were attached, future BA output must include this section.';
  }

  return truncate(section, MAX_VISUAL_CONTRACT_CHARS);
}

function uxContractExcerpt(contract?: UXContractOutput | null) {
  if (!contract) return 'No UX contract was generated yet. Future runs should create one before DEV implementation.';
  return truncate(
    [
      `Summary: ${contract.summary}`,
      '',
      `Information Architecture:\n${contract.informationArchitecture}`,
      '',
      `Layout Contract:\n${contract.layoutContract}`,
      '',
      `Component Inventory:\n${contract.componentInventory.map((item) => `- ${item}`).join('\n')}`,
      '',
      `Visual Design Tokens:\n${contract.visualDesignTokens}`,
      '',
      `Image Treatment:\n${contract.imageTreatment}`,
      '',
      `Responsive Rules:\n${contract.responsiveRules}`,
      '',
      `Interaction Rules:\n${contract.interactionRules}`,
      '',
      `Consistency Rules:\n${contract.consistencyRules.map((item) => `- ${item}`).join('\n')}`,
      '',
      `DEV Handoff Checklist:\n${contract.devHandoffChecklist.map((item) => `- ${item}`).join('\n')}`
    ].join('\n'),
    MAX_VISUAL_CONTRACT_CHARS
  );
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function fileName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseJson(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function bulletList(values: string[], fallback = 'Not detected.') {
  const items = unique(values);
  return items.length ? items.map((value) => `- ${value}`).join('\n') : `- ${fallback}`;
}

function normalizeProjectId(projectId?: string | null) {
  const normalized = (projectId || DEFAULT_PROJECT_ID).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROJECT_ID;
}

export function projectIdFromGeneratedCodePath(generatedCodePath: string) {
  const baseName = path.basename(path.resolve(generatedCodePath));
  return normalizeProjectId(baseName || DEFAULT_PROJECT_ID);
}

export function getProjectSkillDir(projectId = DEFAULT_PROJECT_ID) {
  return path.join(process.cwd(), 'project-skills', normalizeProjectId(projectId));
}

export function getProjectDevContextPath(projectId = DEFAULT_PROJECT_ID) {
  return path.join(getProjectSkillDir(projectId), PROJECT_DEV_CONTEXT_FILENAME);
}

export function getLegacyProjectDevSkillPath(projectId = DEFAULT_PROJECT_ID) {
  return path.join(getProjectSkillDir(projectId), LEGACY_PROJECT_DEV_SKILL_FILENAME);
}

export function getProjectDevSkillPath(projectId = DEFAULT_PROJECT_ID) {
  return getProjectDevContextPath(projectId);
}

export function getProjectSkillMetadataPath(projectId = DEFAULT_PROJECT_ID) {
  return path.join(getProjectSkillDir(projectId), 'project-skill.json');
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function packageSummaries(files: GeneratedFile[]) {
  return files
    .filter((file) => fileName(file.path).toLowerCase() === 'package.json')
    .map((file) => {
      const parsed = parseJson(file.content);
      const scripts = Object.entries(parsed?.scripts ?? {}).map(([name, command]) => `${dirName(file.path)}: npm run ${name} -> ${command}`);
      const deps = Object.keys(parsed?.dependencies ?? {});
      const devDeps = Object.keys(parsed?.devDependencies ?? {});
      return {
        path: normalizePath(file.path),
        directory: dirName(file.path),
        scripts,
        deps,
        devDeps
      };
    });
}

function inferPackageManager(files: GeneratedFile[]) {
  const paths = files.map((file) => normalizePath(file.path).toLowerCase());
  if (paths.some((filePath) => filePath.endsWith('pnpm-lock.yaml'))) return 'pnpm';
  if (paths.some((filePath) => filePath.endsWith('yarn.lock'))) return 'yarn';
  if (paths.some((filePath) => filePath.endsWith('package-lock.json'))) return 'npm ci when lockfile exists, npm otherwise';
  if (paths.some((filePath) => filePath.endsWith('package.json'))) return 'npm';
  return 'Not detected';
}

function inferStack(files: GeneratedFile[]) {
  const allContent = files.map((file) => `${file.path}\n${file.content}`).join('\n').toLowerCase();
  const packageData = packageSummaries(files);
  const deps = packageData.flatMap((summary) => [...summary.deps, ...summary.devDeps]).map((dep) => dep.toLowerCase());

  const frontend = packageData.some((summary) => normalizePath(summary.path).startsWith('frontend/'))
    ? `Detected from frontend manifests: ${unique(deps).slice(0, 12).join(', ') || 'manifest present'}`
    : 'Not detected';
  const backendManifests = files.filter((file) => normalizePath(file.path).startsWith('backend/') && /^(package\.json|requirements\.txt|pyproject\.toml)$/i.test(fileName(file.path)));
  const backend = backendManifests.length ? `Detected from backend manifests: ${backendManifests.map((file) => normalizePath(file.path)).join(', ')}` : 'Not detected';
  const dataSignals = unique(
    [
      ...files.filter((file) => /(^|\/)(database|db|migrations?|schema|seed|init)/i.test(normalizePath(file.path))).map((file) => normalizePath(file.path)),
      ...envKeys(files).filter((key) => /DB|DATA|STORE|CONNECTION/i.test(key))
    ].slice(0, 20)
  );
  const database = dataSignals.length ? `Detected from generated data/config signals: ${dataSignals.join(', ')}` : 'Not detected';
  const dataDependencies = unique(deps.filter((dep) => /sql|db|orm|data|migrate|schema|store/i.test(dep)));
  const orm = dataDependencies.length ? `Detected data dependencies: ${dataDependencies.join(', ')}` : 'Not detected';
  const container = files.some((file) => /(^|\/)(dockerfile|containerfile)$/i.test(fileName(file.path)) || /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(fileName(file.path))) ? 'Container configuration files present' : 'No generated container files detected';

  return { frontend, backend, database, orm, packageManager: inferPackageManager(files), container };
}

function envKeys(files: GeneratedFile[]) {
  return unique(
    files
      .filter((file) => /\.env\.example$/i.test(fileName(file.path)) || fileName(file.path).toLowerCase() === '.env.example')
      .flatMap((file) =>
        file.content
          .split(/\r?\n/)
          .map((line) => line.trim().match(/^([A-Z_][A-Z0-9_]*)\s*=/)?.[1] || '')
      )
  );
}

function commandSummaries(files: GeneratedFile[]) {
  const packageCommands = packageSummaries(files).flatMap((summary) => summary.scripts);
  const containerCommands = files.some((file) => /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(fileName(file.path))) ? ['root: container orchestration command is documented in the generated README and skill contract'] : [];
  const backendDependencyCommands = files
    .filter((file) => /requirements\.txt$/i.test(file.path) || /pyproject\.toml$/i.test(file.path))
    .map((file) => `${dirName(file.path)}: install backend dependencies from ${fileName(file.path)}`);

  return unique([...packageCommands, ...containerCommands, ...backendDependencyCommands]);
}

function routeSummaries(files: GeneratedFile[]) {
  const routes: string[] = [];

  for (const file of files) {
    const normalized = normalizePath(file.path);
    if (/\/app\/api\/.+\/route\.(tsx?|jsx?)$/i.test(normalized)) {
      routes.push(`API route file: ${normalized}`);
    }

    if (/\/app\/.+\/page\.(tsx?|jsx?)$/i.test(normalized) || /(^|\/)pages\/.+\.(tsx?|jsx?)$/i.test(normalized)) {
      routes.push(`Frontend route/page file: ${normalized}`);
    }

    if (/\.py$/i.test(normalized)) {
      for (const match of Array.from(file.content.matchAll(/@(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g))) {
        routes.push(`${normalized}: ${match[1].toUpperCase()} ${match[2]}`);
      }
    }
  }

  return unique(routes);
}

function conventionSummaries(files: GeneratedFile[]) {
  const normalizedPaths = files.map((file) => normalizePath(file.path));
  const hasAppDir = normalizedPaths.some((filePath) => /(^|\/)app\//.test(filePath));
  const hasComponents = normalizedPaths.some((filePath) => /(^|\/)components\//.test(filePath));
  const hasBackendApp = normalizedPaths.some((filePath) => /backend\/app\//.test(filePath));
  const hasFlatBackend = normalizedPaths.some((filePath) => /^backend\/[^/]+\.py$/.test(filePath));
  const hasDockerCompose = normalizedPaths.some((filePath) => /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(filePath));

  return unique([
    hasAppDir ? 'Frontend uses app-directory style routing. Add new pages/routes under the existing app tree.' : '',
    hasComponents ? 'Shared frontend UI belongs under the existing components directory.' : '',
    hasBackendApp ? 'Backend uses a package-style backend/app layout. Keep imports and service entrypoints aligned with that package.' : '',
    hasFlatBackend ? 'Backend uses a flat backend directory. Keep imports and service entrypoints aligned with that layout.' : '',
    hasDockerCompose ? 'Container wiring lives in the root Compose file and service Dockerfiles. Keep host/container ports consistent.' : ''
  ]);
}

function migrationSummaries(files: GeneratedFile[]) {
  const paths = files.map((file) => normalizePath(file.path));
  const migrationFiles = paths.filter((filePath) => /migration|schema|initdb|database|db/i.test(filePath));
  const seedFiles = paths.filter((filePath) => /seed|fixture|sample-data/i.test(filePath));
  return unique([...migrationFiles.map((filePath) => `Schema/migration file: ${filePath}`), ...seedFiles.map((filePath) => `Seed/sample data file: ${filePath}`)]);
}

async function readExistingProjectContextMarkdown(projectId: string) {
  for (const candidate of [getProjectDevContextPath(projectId), getLegacyProjectDevSkillPath(projectId)]) {
    if (await pathExists(candidate)) {
      return fs.readFile(candidate, 'utf-8');
    }
  }

  return '';
}

function previousLearningLessons(previousMarkdown: string) {
  const body = extractMarkdownSectionBody(previousMarkdown, 'TA Learning Memory');
  if (!body) return [];

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .filter((line) => !/No accumulated failure lessons yet/i.test(line));
}

function compactLearningNote(note: string) {
  const normalized = note.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const compacted = normalized.length <= 700 ? normalized : `${normalized.slice(0, 700)} ...[truncated ${normalized.length - 700} chars]`;
  return `- ${compacted}`;
}

function learningNotesFromSignals(input: {
  reason: string;
  executionValidation?: GeneratedExecutionValidationResult;
  qaReview?: QAReviewOutput;
  learningNotes?: string[];
}) {
  const notes: string[] = [];

  if (/feedback|repair|fix|validation|qa|deploy|review|readiness/i.test(input.reason)) {
    notes.push(`Trigger: ${input.reason}`);
  }

  for (const note of input.learningNotes ?? []) {
    notes.push(note);
  }

  if (input.executionValidation?.status === 'NEEDS_FIX') {
    notes.push(`Execution validation failed. Findings: ${(input.executionValidation.findings ?? []).join('; ') || 'No explicit findings.'}`);
    if (input.executionValidation.fixInstructions?.trim()) {
      notes.push(`Execution repair guidance: ${input.executionValidation.fixInstructions}`);
    }
  }

  if (input.qaReview?.status === 'NEEDS_FIX') {
    notes.push(`QA failed. Findings: ${(input.qaReview.findings ?? []).join('; ') || 'No explicit findings.'}`);
    if (input.qaReview.fixInstructions?.trim()) {
      notes.push(`QA repair guidance: ${input.qaReview.fixInstructions}`);
    }
  }

  return notes.map(compactLearningNote).filter(Boolean);
}

function taLearningMemory(previousMarkdown: string, input: {
  reason: string;
  executionValidation?: GeneratedExecutionValidationResult;
  qaReview?: QAReviewOutput;
  learningNotes?: string[];
}) {
  const existing = previousLearningLessons(previousMarkdown);
  const next = learningNotesFromSignals(input);
  const combined = unique([...existing, ...next]).slice(-60);
  const markdown = combined.length ? combined.join('\n') : '- No accumulated failure lessons yet.';
  return truncate(markdown, MAX_LEARNING_MEMORY_CHARS);
}

function finalStatus(input: ProjectDevSkillWriteInput) {
  const statusLines = [
    `Last update reason: ${input.reason}`,
    input.executionValidation ? `Latest deploy smoke validation: ${input.executionValidation.status}` : 'Latest deploy smoke validation: not recorded yet',
    input.qaReview ? `Latest QA status: ${input.qaReview.status}` : 'Latest QA status: not recorded yet'
  ];

  const findings = [...(input.executionValidation?.findings ?? []), ...(input.qaReview?.findings ?? [])];
  return `${statusLines.map((line) => `- ${line}`).join('\n')}\n${findings.length ? findings.map((finding) => `- Known issue: ${finding}`).join('\n') : '- Known limitations: none recorded by the latest validation.'}`;
}

async function readProjectDevSkillTemplate() {
  const candidates = [
    path.join(process.cwd(), '.github', 'skills', 'project-dev-template', 'SKILL.md'),
    path.join(process.cwd(), '.github', 'skills', 'project-dev-template.md')
  ];
  let templatePath = candidates[0];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      templatePath = candidate;
      break;
    }
  }
  try {
    return await fs.readFile(templatePath, 'utf-8');
  } catch (error) {
    throw new Error(`TA DEV context template is missing or unreadable at ${templatePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => values[key] ?? match);
}

async function buildProjectDevSkillMarkdown(input: ProjectDevSkillWriteInput) {
  const projectId = normalizeProjectId(input.projectId);
  const previousMarkdown = await readExistingProjectContextMarkdown(projectId);
  const files = input.devOutput.files;
  const stack = inferStack(files);
  const overview = formatGeneratedProjectOverview(files);
  const commands = commandSummaries(files);
  const routes = routeSummaries(files);
  const conventions = conventionSummaries(files);
  const migrations = migrationSummaries(files);

  return renderTemplate(await readProjectDevSkillTemplate(), {
    PROJECT_ID: projectId,
    UPDATED_AT: new Date().toISOString(),
    REQUIREMENTS_EXCERPT: truncate(input.requirements || 'Not provided.', MAX_REQUIREMENTS_EXCERPT_CHARS),
    BA_OUTPUT_EXCERPT: truncate(input.baOutput || 'Not provided.', MAX_BA_EXCERPT_CHARS),
    VISUAL_CONTRACT_EXCERPT: visualContractExcerpt(input.baOutput || ''),
    UX_CONTRACT: uxContractExcerpt(input.uxContract),
    PREPARED_TECH_STACK: JSON.stringify(input.preparedTechStack ?? null, null, 2),
    FRONTEND_STACK: stack.frontend,
    BACKEND_STACK: stack.backend,
    DATABASE_STACK: stack.database,
    ORM_STACK: stack.orm,
    PACKAGE_MANAGER: stack.packageManager,
    CONTAINER_STACK: stack.container,
    PROJECT_OVERVIEW: truncate(overview, MAX_SKILL_SECTION_CHARS),
    COMMANDS: bulletList(commands, 'No runnable commands detected from manifests yet. Preserve or add manifest scripts when adding features.'),
    ENV_KEYS: bulletList(envKeys(files), 'No env example keys detected. Add safe .env.example keys before requiring runtime config.'),
    ROUTES: bulletList(routes, 'No route conventions detected yet. Follow the existing framework layout when adding routes.'),
    CONVENTIONS: bulletList(conventions, 'Follow the existing directory structure and import style visible in generated-code.'),
    MIGRATIONS: bulletList(migrations, 'No explicit migration/seed files detected. If the app owns a database, add schema/init safely and preserve existing data behavior.'),
    TA_LEARNING_MEMORY: taLearningMemory(previousMarkdown, input),
    FINAL_STATUS: finalStatus(input)
  });
}

export function validateProjectDevSkillMarkdown(markdown: string, files: GeneratedFile[]): ProjectDevSkillValidation {
  const findings: string[] = [];
  if (/\{\{[A-Z0-9_]+\}\}/.test(markdown)) findings.push('Project dev skill has unreplaced template placeholders.');
  if (!markdown.trim()) findings.push('Project dev skill is empty.');

  const representativeFiles = files.slice(0, 5).map((file) => normalizePath(file.path));
  for (const filePath of representativeFiles) {
    if (!markdown.includes(filePath)) findings.push(`Project dev skill does not mention generated file: ${filePath}`);
  }

  return {
    status: findings.length ? 'NEEDS_FIX' : 'PASS',
    findings
  };
}

export async function loadProjectDevSkill(projectId = DEFAULT_PROJECT_ID): Promise<ProjectDevSkill | null> {
  const normalizedProjectId = normalizeProjectId(projectId);
  const skillPath = (await pathExists(getProjectDevContextPath(normalizedProjectId)))
    ? getProjectDevContextPath(normalizedProjectId)
    : getLegacyProjectDevSkillPath(normalizedProjectId);
  if (!(await pathExists(skillPath))) return null;

  const markdown = await fs.readFile(skillPath, 'utf-8');
  const parsed = parseSkillMarkdown(markdown, skillPath);
  return {
    ...parsed,
    projectId: normalizedProjectId,
    path: skillPath
  };
}

export interface PreDevProjectSkillInput {
  projectId?: string;
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  preparedTechStack: PreparedTechStackOutput;
  uxContract?: UXContractOutput;
  existingFiles?: GeneratedFile[];
}

/**
 * Write TA's project-specific DEV context BEFORE DEV agent runs.
 * Static DEV behavior stays in .github/skills/dev/SKILL.md; this file stores
 * project memory, stack decisions, UX contract, and accumulated lessons.
 * After DEV generates code, call writeProjectDevSkill to update file analysis.
 */
export async function writePreDevProjectSkill(input: PreDevProjectSkillInput): Promise<ProjectDevSkill> {
  const projectId = normalizeProjectId(input.projectId);
  const skillDir = getProjectSkillDir(projectId);
  const skillPath = getProjectDevSkillPath(projectId);
  const metadataPath = getProjectSkillMetadataPath(projectId);
  const previousMarkdown = await readExistingProjectContextMarkdown(projectId);

  const files = input.existingFiles ?? [];
  const stack = files.length > 0 ? inferStack(files) : {
    frontend: `Planned: ${input.preparedTechStack.frontendFramework}`,
    backend: `Planned: ${input.preparedTechStack.backendFramework}`,
    database: `Planned: ${input.preparedTechStack.database}`,
    orm: `Planned: ${input.preparedTechStack.ormMigrationTool}`,
    packageManager: input.preparedTechStack.packageManager,
    container: `Planned: ${input.preparedTechStack.dockerStrategy}`
  };

  const overview = files.length > 0
    ? formatGeneratedProjectOverview(files)
    : 'No files generated yet. DEV agent will create the initial scaffold based on the prepared tech stack.';

  const template = await readProjectDevSkillTemplate();
  const markdown = renderTemplate(template, {
    PROJECT_ID: projectId,
    UPDATED_AT: new Date().toISOString(),
    REQUIREMENTS_EXCERPT: truncate(input.requirements || 'Not provided.', MAX_REQUIREMENTS_EXCERPT_CHARS),
    BA_OUTPUT_EXCERPT: truncate(input.baOutput || 'Not provided.', MAX_BA_EXCERPT_CHARS),
    VISUAL_CONTRACT_EXCERPT: visualContractExcerpt(input.baOutput || ''),
    UX_CONTRACT: uxContractExcerpt(input.uxContract),
    PREPARED_TECH_STACK: JSON.stringify(input.preparedTechStack, null, 2),
    FRONTEND_STACK: stack.frontend,
    BACKEND_STACK: stack.backend,
    DATABASE_STACK: stack.database,
    ORM_STACK: stack.orm,
    PACKAGE_MANAGER: stack.packageManager,
    CONTAINER_STACK: stack.container,
    PROJECT_OVERVIEW: overview,
    COMMANDS: files.length > 0 ? bulletList(commandSummaries(files)) : '- Will be determined after initial code generation.',
    ENV_KEYS: files.length > 0 ? bulletList(envKeys(files)) : bulletList(
      input.preparedTechStack.environmentVariables?.map(e => e.name) ?? [],
      'Will be determined after initial code generation.'
    ),
    ROUTES: files.length > 0 ? bulletList(routeSummaries(files)) : '- Will be determined after initial code generation.',
    CONVENTIONS: files.length > 0 ? bulletList(conventionSummaries(files)) : '- Follow the prepared tech stack architecture decisions above.',
    MIGRATIONS: files.length > 0 ? bulletList(migrationSummaries(files)) : '- Will be determined after initial code generation.',
    TA_LEARNING_MEMORY: taLearningMemory(previousMarkdown, {
      reason: 'Pre-DEV context preparation from tech stack analysis.'
    }),
    FINAL_STATUS: `- Last update reason: Pre-DEV context preparation from tech stack analysis.\n- Latest deploy smoke validation: not yet run\n- Latest QA status: not yet run`
  });

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillPath, markdown, 'utf-8');
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        projectId,
        skillPath,
        contextPath: skillPath,
        staticDevSkillPath: path.join(process.cwd(), '.github', 'skills', 'dev', 'SKILL.md'),
        legacySkillPath: getLegacyProjectDevSkillPath(projectId),
        generatedCodePath: path.join(process.cwd(), 'generated-code'),
        updatedAt: new Date().toISOString(),
        reason: 'Pre-DEV context preparation from tech stack analysis.',
        fileCount: files.length,
        phase: 'pre-dev'
      },
      null,
      2
    )
  );

  const loaded = await loadProjectDevSkill(projectId);
  if (!loaded) throw new Error(`Pre-DEV project skill was not written at ${skillPath}.`);
  return loaded;
}

export async function writeProjectDevSkill(input: ProjectDevSkillWriteInput): Promise<ProjectDevSkill> {
  const projectId = normalizeProjectId(input.projectId);
  const skillDir = getProjectSkillDir(projectId);
  const skillPath = getProjectDevSkillPath(projectId);
  const metadataPath = getProjectSkillMetadataPath(projectId);
  const markdown = await buildProjectDevSkillMarkdown({ ...input, projectId });
  const validation = validateProjectDevSkillMarkdown(markdown, input.devOutput.files);

  if (validation.status !== 'PASS') {
    throw new Error(`Generated TA DEV context is invalid: ${validation.findings.join('; ')}`);
  }

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillPath, markdown, 'utf-8');
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        projectId,
        skillPath,
        contextPath: skillPath,
        staticDevSkillPath: path.join(process.cwd(), '.github', 'skills', 'dev', 'SKILL.md'),
        legacySkillPath: getLegacyProjectDevSkillPath(projectId),
        generatedCodePath: path.join(process.cwd(), 'generated-code'),
        updatedAt: new Date().toISOString(),
        reason: input.reason,
        fileCount: input.devOutput.files.length,
        executionValidationStatus: input.executionValidation?.status,
        qaStatus: input.qaReview?.status
      },
      null,
      2
    )
  );

  const loaded = await loadProjectDevSkill(projectId);
  if (!loaded) throw new Error(`Project dev skill was not written at ${skillPath}.`);
  return loaded;
}
