import type { GeneratedFile, RunResult } from '@/lib/types';

const MAX_CODE_FILES = 30;
const MAX_CODE_FILE_CHARS = 6_000;
const MAX_CODE_CONTEXT_CHARS = 70_000;
const MAX_HISTORY_RUNS = 5;
const MAX_HISTORY_SECTION_CHARS = 1_500;
const MAX_OVERVIEW_FILES = 180;
const MAX_OVERVIEW_SECTION_CHARS = 4_000;
const MAX_OVERVIEW_CHARS = 18_000;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
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

function parseJson(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatNameList(values: string[], maxItems = 24) {
  if (values.length === 0) return 'none';
  const visible = values.slice(0, maxItems).join(', ');
  return values.length > maxItems ? `${visible}, ...and ${values.length - maxItems} more` : visible;
}

function selectedDockerLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(FROM|WORKDIR|COPY|RUN|CMD|ENTRYPOINT|EXPOSE|HEALTHCHECK|ENV)\b/i.test(line))
    .slice(0, 30)
    .join('\n');
}

function selectedComposeLines(content: string) {
  return content
    .split(/\r?\n/)
    .filter((line) => /^\s{0,6}(services:|[a-z0-9_-]+:|build:|context:|dockerfile:|image:|command:|ports:|environment:|depends_on:|healthcheck:|volumes:)/i.test(line))
    .slice(0, 90)
    .join('\n');
}

function selectedFrameworkConfigLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(const|module\.exports|export default|export const|plugins:|content:|theme:|output:|distDir:|basePath:|rewrites|redirects|images:|server:|proxy:|build:|defineConfig|\})/i.test(line))
    .slice(0, 50)
    .join('\n');
}

function envKeys(content: string) {
  return unique(
    content
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^([A-Z_][A-Z0-9_]*)\s*=/)?.[1] || '')
  );
}

function importSummary(file: GeneratedFile) {
  const path = normalizePath(file.path);
  const imports: string[] = [];

  if (/\.(tsx?|jsx?|mjs|cjs)$/i.test(path)) {
    for (const match of Array.from(file.content.matchAll(/(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]/g))) {
      imports.push(match[1]);
    }
  }

  if (/\.py$/i.test(path)) {
    for (const match of Array.from(file.content.matchAll(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/gm))) {
      imports.push(match[1] || match[2]);
    }
  }

  return unique(imports);
}

function routeSummary(file: GeneratedFile) {
  const path = normalizePath(file.path);
  const routes: string[] = [];

  if (/\.py$/i.test(path)) {
    for (const match of Array.from(file.content.matchAll(/@(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g))) {
      routes.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }

  if (/\/app\/api\/.+\/route\.(tsx?|jsx?)$/i.test(path)) {
    routes.push(`Next route file ${path}`);
  }

  return unique(routes);
}

export function formatGeneratedProjectOverview(files: GeneratedFile[]) {
  if (files.length === 0) return 'No generated project overview yet.';

  const sortedFiles = [...files].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path)));
  const tree = sortedFiles
    .slice(0, MAX_OVERVIEW_FILES)
    .map((file) => `- ${normalizePath(file.path)} (${Buffer.byteLength(file.content, 'utf8')} bytes)`)
    .join('\n');

  const packageSummaries = sortedFiles
    .filter((file) => fileName(file.path).toLowerCase() === 'package.json')
    .map((file) => {
      const parsed = parseJson(file.content);
      const scripts = Object.keys(parsed?.scripts ?? {});
      const deps = Object.keys(parsed?.dependencies ?? {});
      const devDeps = Object.keys(parsed?.devDependencies ?? {});
      return [`- ${normalizePath(file.path)} in ${dirName(file.path)}`, `  scripts: ${formatNameList(scripts)}`, `  dependencies: ${formatNameList(deps)}`, `  devDependencies: ${formatNameList(devDeps)}`].join('\n');
    })
    .join('\n');

  const tsConfigSummaries = sortedFiles
    .filter((file) => /^(tsconfig|jsconfig)\.json$/i.test(fileName(file.path)))
    .map((file) => {
      const parsed = parseJson(file.content);
      return `- ${normalizePath(file.path)} baseUrl=${parsed?.compilerOptions?.baseUrl ?? 'not set'} paths=${formatNameList(Object.keys(parsed?.compilerOptions?.paths ?? {}), 8)}`;
    })
    .join('\n');

  const frameworkConfigs = sortedFiles
    .filter((file) => /^(next\.config\.(js|mjs|cjs|ts)|vite\.config\.(js|mjs|ts)|tailwind\.config\.(js|mjs|cjs|ts)|postcss\.config\.(js|mjs|cjs))$/i.test(fileName(file.path)))
    .map((file) => {
      const selected = selectedFrameworkConfigLines(file.content);
      return `### ${normalizePath(file.path)}\n${truncate(selected || file.content, MAX_OVERVIEW_SECTION_CHARS)}`;
    })
    .join('\n\n');

  const pythonManifests = sortedFiles
    .filter((file) => /^(requirements\.txt|pyproject\.toml)$/i.test(fileName(file.path)))
    .map((file) => `- ${normalizePath(file.path)}\n${truncate(file.content, 1_200)}`)
    .join('\n');

  const envSummary = sortedFiles
    .filter((file) => /\.env\.example$/i.test(fileName(file.path)) || fileName(file.path).toLowerCase() === '.env.example')
    .map((file) => `- ${normalizePath(file.path)} keys: ${formatNameList(envKeys(file.content), 40)}`)
    .join('\n');

  const containerSummary = sortedFiles
    .filter((file) => /^(dockerfile|containerfile)$/i.test(fileName(file.path)) || /^(compose|docker-compose)\.ya?ml$/i.test(fileName(file.path)))
    .map((file) => {
      const selected = /ya?ml$/i.test(fileName(file.path)) ? selectedComposeLines(file.content) : selectedDockerLines(file.content);
      return `### ${normalizePath(file.path)}\n${truncate(selected || file.content, MAX_OVERVIEW_SECTION_CHARS)}`;
    })
    .join('\n\n');

  const imports = sortedFiles
    .map((file) => ({ path: normalizePath(file.path), imports: importSummary(file) }))
    .filter((item) => item.imports.length > 0)
    .slice(0, 80)
    .map((item) => `- ${item.path}: ${formatNameList(item.imports, 16)}`)
    .join('\n');

  const routes = sortedFiles
    .map((file) => ({ path: normalizePath(file.path), routes: routeSummary(file) }))
    .filter((item) => item.routes.length > 0)
    .slice(0, 80)
    .map((item) => `- ${item.path}: ${item.routes.join(', ')}`)
    .join('\n');

  const overview = [
    '## Generated Project Overview',
    'Use this map with the latest validation/build log to choose the smallest correct repair. Compare missing imports, Docker COPY paths, service build contexts, scripts, env vars, and runtime entrypoints against the tree before selecting files.',
    '',
    '### File Tree',
    tree,
    sortedFiles.length > MAX_OVERVIEW_FILES ? `- ...and ${sortedFiles.length - MAX_OVERVIEW_FILES} more file(s)` : '',
    '',
    '### Package Manifests',
    packageSummaries || 'none',
    '',
    '### TS/JS Path Alias Config',
    tsConfigSummaries || 'none',
    '',
    '### Framework Configs',
    frameworkConfigs || 'none',
    '',
    '### Python Manifests',
    pythonManifests || 'none',
    '',
    '### Env Examples',
    envSummary || 'none',
    '',
    '### Container And Compose Summary',
    containerSummary || 'none',
    '',
    '### Source Imports',
    imports || 'none',
    '',
    '### API Routes',
    routes || 'none'
  ]
    .filter((section) => section !== '')
    .join('\n');

  return truncate(overview, MAX_OVERVIEW_CHARS);
}

export function formatGeneratedCodeContext(files: GeneratedFile[]) {
  if (files.length === 0) return 'No existing generated code.';

  const sections: string[] = [];
  let totalChars = 0;

  for (const file of files.slice(0, MAX_CODE_FILES)) {
    const content = truncate(file.content, MAX_CODE_FILE_CHARS);
    const section = `### ${file.path}\n\n\`\`\`\n${content}\n\`\`\``;

    if (totalChars + section.length > MAX_CODE_CONTEXT_CHARS) {
      sections.push('...[generated code context truncated]');
      break;
    }

    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

export function formatRunHistoryContext(runs: RunResult[]) {
  if (runs.length === 0) return 'No previous runs.';

  return runs
    .slice(0, MAX_HISTORY_RUNS)
    .map((run) => {
      const files = run.devOutput?.files?.map((file) => file.path).join(', ') || 'No generated files recorded.';
      const findings = run.qaFindings?.length ? run.qaFindings.join('; ') : 'No QA findings recorded.';

      return [
        `## ${run.runId}`,
        `Created: ${run.createdAt}`,
        `Topic: ${run.topic}`,
        `QA status: ${run.qaStatus || 'Not recorded'}`,
        `Build readiness fix iterations: ${run.buildReadinessFixIterations ?? 0}`,
        `Execution validation status: ${run.executionValidation?.status || 'Not recorded'}`,
        `Execution validation fix iterations: ${run.executionValidationFixIterations ?? 0}`,
        `QA fix iterations: ${run.qaFixIterations ?? 0}`,
        `Generated files: ${files}`,
        `QA findings: ${truncate(findings, MAX_HISTORY_SECTION_CHARS)}`,
        `Execution findings: ${truncate(run.executionValidation?.findings?.join('; ') || 'No execution findings recorded.', MAX_HISTORY_SECTION_CHARS)}`,
        `BA excerpt:\n${truncate(run.baOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `QA report excerpt:\n${truncate(run.qaOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Setup excerpt:\n${truncate(run.devOutput?.setupInstructions || '', MAX_HISTORY_SECTION_CHARS)}`
      ].join('\n');
    })
    .join('\n\n');
}
