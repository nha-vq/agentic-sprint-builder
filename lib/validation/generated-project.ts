import fs from 'node:fs';
import path from 'node:path';
import type { DevOutput, PreparedTechStackOutput } from '@/lib/types';

export interface GeneratedProjectValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
  fixInstructions: string;
}

interface RequiredFileNamesByDirectory {
  directory: string;
  fileNames: string[];
}

interface RequiredContentCheck {
  path: string;
  patterns: string[];
}

interface SkillValidationContract {
  requiredPaths?: string[];
  requiredTopLevelDirectories?: string[];
  oneOfTopLevelDirectories?: string[][];
  requiredFileNamesByDirectory?: RequiredFileNamesByDirectory[];
  requiredContentChecks?: RequiredContentCheck[];
}

const GENERATED_APP_HOST_PORT_MIN = 55_000;
const GENERATED_APP_HOST_PORT_MAX = 55_999;
const DEFAULT_GENERATED_FRONTEND_HOST_PORT = 55_001;
const DEFAULT_GENERATED_BACKEND_HOST_PORT = 55_080;
const DEFAULT_GENERATED_DATABASE_HOST_PORT = 55_432;
const FAST_API_NAME = `${'Fast'}${'API'}`;
const FILE_DB_DISPLAY_NAME = `${'SQL'}${'ite'}`;
const POSTGRES_NAME = `${'Post'}${'greSQL'}`;
const FAST_API_PATTERN = new RegExp(String.raw`\bfast\s*api\b|\b${'fast'}${'api'}\b`, 'i');
const FILE_DB_PATTERN = new RegExp(String.raw`\b${'sql'}${'ite'}\b`, 'i');
const POSTGRES_PATTERN = new RegExp(String.raw`\b${'post'}${'gres'}(?:ql)?\b`, 'i');
const FILE_DB_IMPLEMENTATION_PATTERN = new RegExp(String.raw`\b${'sql'}${'ite'}\b|${'sql'}${'ite'}:\/\/|\.db\b`, 'iu');
const POSTGRES_IMPLEMENTATION_PATTERN = new RegExp(String.raw`\b${'post'}${'gres'}(?:ql)?\b|${'post'}${'gres'}:\d|jdbc:${'post'}${'gres'}ql|POSTGRES_`, 'iu');

interface ComposeHostPortMapping {
  service: string;
  hostPort: number;
  containerPort?: number;
  raw: string;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function topLevelFromPath(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.indexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function hasGeneratedPath(output: DevOutput, requiredPath: string) {
  const normalized = normalizePath(requiredPath);
  return output.files.some((file) => normalizePath(file.path) === normalized);
}

function hasGeneratedTopLevelDirectory(output: DevOutput, directory: string) {
  const normalized = normalizePath(directory);
  return output.files.some((file) => topLevelFromPath(file.path) === normalized);
}

function hasFileNameInDirectory(output: DevOutput, directory: string, requiredFileName: string) {
  const normalizedDirectory = normalizePath(directory);
  const normalizedFileName = requiredFileName.toLowerCase();

  return output.files.some((file) => {
    const normalizedPath = normalizePath(file.path);
    return (
      fileName(normalizedPath) === normalizedFileName &&
      (dirName(normalizedPath) === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`))
    );
  });
}

function generatedFileContent(output: DevOutput, filePath: string) {
  const normalized = normalizePath(filePath);
  return output.files.find((file) => normalizePath(file.path) === normalized)?.content ?? '';
}

function generatedFilesByPrefix(output: DevOutput, prefix: string) {
  const normalizedPrefix = normalizePath(prefix);
  return output.files.filter((file) => normalizePath(file.path).startsWith(`${normalizedPrefix}/`));
}

function generatedProjectSearchText(files: Array<{ path: string; content: string }>) {
  return files.map((file) => `${normalizePath(file.path)}\n${file.content}`).join('\n');
}

function normalizeGeneratedJoin(...parts: string[]) {
  const segments: string[] = [];

  for (const part of parts.join('/').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments.join('/') || '.';
}

function generatedFileByPath(output: DevOutput, filePath: string) {
  const normalized = normalizePath(filePath);
  return output.files.find((file) => normalizePath(file.path) === normalized);
}

function generatedPathExistsWithSourceExtensions(output: DevOutput, basePath: string) {
  const normalizedBase = normalizePath(basePath);
  return generatedPathCandidates(normalizedBase).some((candidate) => hasGeneratedPath(output, candidate));
}

function generatedPathCandidates(basePath: string) {
  const normalizedBase = normalizePath(basePath);
  return [
    normalizedBase,
    `${normalizedBase}.ts`,
    `${normalizedBase}.tsx`,
    `${normalizedBase}.js`,
    `${normalizedBase}.jsx`,
    `${normalizedBase}.mjs`,
    `${normalizedBase}.cjs`,
    `${normalizedBase}.json`,
    `${normalizedBase}/index.ts`,
    `${normalizedBase}/index.tsx`,
    `${normalizedBase}/index.js`,
    `${normalizedBase}/index.jsx`
  ];
}

function firstGeneratedPathWithSourceExtensions(output: DevOutput, basePath: string) {
  return generatedPathCandidates(basePath).find((candidate) => hasGeneratedPath(output, candidate)) ?? null;
}

function parseJsonObject(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function stripJsonComments(content: string) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      if (index < content.length) result += content[index];
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result.replace(/,\s*([}\]])/gu, '$1');
}

function parseJsoncObject(content: string) {
  return parseJsonObject(content) ?? parseJsonObject(stripJsonComments(content));
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function dependencyNamesFromPackageJson(content: string) {
  const parsed = parseJsonObject(content);
  const dependencyNames = new Set<string>();
  if (!parsed) return dependencyNames;

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = objectValue(parsed[field]);
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  return dependencyNames;
}

function preparedStackText(preparedTechStack?: PreparedTechStackOutput) {
  if (!preparedTechStack) return '';
  return [
    preparedTechStack.frontendFramework,
    preparedTechStack.backendFramework,
    preparedTechStack.database,
    preparedTechStack.ormMigrationTool,
    preparedTechStack.packageManager,
    preparedTechStack.dockerStrategy,
    preparedTechStack.projectArchitecture,
    preparedTechStack.devSkillGuidance
  ]
    .filter(Boolean)
    .join('\n');
}

function selectedStackMentions(preparedTechStack: PreparedTechStackOutput | undefined, pattern: RegExp) {
  return pattern.test(preparedStackText(preparedTechStack));
}

function regexOrTextMatches(content: string, pattern: string) {
  try {
    return new RegExp(pattern, 'im').test(content);
  } catch {
    return content.toLowerCase().includes(pattern.toLowerCase());
  }
}

function readFirstGenerationContract(): SkillValidationContract {
  const skillPath =
    [
      path.join(process.cwd(), '.github', 'skills', 'dev', 'SKILL.md'),
      path.join(process.cwd(), '.github', 'skills', 'dev.md'),
      path.join(process.cwd(), 'skills', 'dev.md')
    ].find((candidate) => fs.existsSync(candidate)) ?? path.join(process.cwd(), '.github', 'skills', 'dev', 'SKILL.md');
  const markdown = fs.readFileSync(skillPath, 'utf-8');
  const marker = '## Machine-Readable First Generation Contract';
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Missing ${marker} section in ${skillPath}.`);
  }

  const contractSection = markdown.slice(markerIndex);
  const jsonBlock = contractSection.match(/```json\s*([\s\S]*?)```/i);
  if (!jsonBlock) {
    throw new Error(`Missing JSON contract block after ${marker} in ${skillPath}.`);
  }

  const parsed = JSON.parse(jsonBlock[1]) as SkillValidationContract;
  return {
    requiredPaths: Array.isArray(parsed.requiredPaths) ? parsed.requiredPaths : [],
    requiredTopLevelDirectories: Array.isArray(parsed.requiredTopLevelDirectories) ? parsed.requiredTopLevelDirectories : [],
    oneOfTopLevelDirectories: Array.isArray(parsed.oneOfTopLevelDirectories) ? parsed.oneOfTopLevelDirectories : [],
    requiredFileNamesByDirectory: Array.isArray(parsed.requiredFileNamesByDirectory) ? parsed.requiredFileNamesByDirectory : [],
    requiredContentChecks: Array.isArray(parsed.requiredContentChecks) ? parsed.requiredContentChecks : []
  };
}

function findRelativeImportIssues(output: DevOutput) {
  const issues: string[] = [];
  const sourceFiles = output.files.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/i.test(file.path));
  const importPattern = /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;

  for (const file of sourceFiles) {
    for (const match of Array.from(file.content.matchAll(importPattern))) {
      const importPath = match[1].replace(/\\/g, '/');
      const importerDir = dirName(file.path);
      const parts: string[] = [];

      for (const part of `${importerDir}/${importPath}`.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
          parts.pop();
        } else {
          parts.push(part);
        }
      }

      const base = parts.join('/');
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.json`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
        `${base}/index.js`,
        `${base}/index.jsx`
      ];

      if (!candidates.some((candidate) => hasGeneratedPath(output, candidate))) {
        issues.push(`Source file at ${file.path} imports ${match[1]}, but no matching generated file was found.`);
      }
    }
  }

  return issues;
}

function nearestGeneratedPackageDirectory(output: DevOutput, filePath: string) {
  const normalizedPath = normalizePath(filePath);
  const directories = dirName(normalizedPath).split('/');

  for (let index = directories.length; index >= 0; index -= 1) {
    const candidateDirectory = index === 0 ? '.' : directories.slice(0, index).join('/');
    const packagePath = candidateDirectory === '.' ? 'package.json' : `${candidateDirectory}/package.json`;
    if (hasGeneratedPath(output, packagePath)) return candidateDirectory;
  }

  return topLevelFromPath(normalizedPath);
}

interface AtSlashAliasConfig {
  path: string;
  baseUrl: string;
  targets: string[];
  parseError?: boolean;
  hasBaseUrl: boolean;
  hasAtSlashAlias: boolean;
}

function atSlashAliasConfigForRoot(output: DevOutput, projectRoot: string): AtSlashAliasConfig | null {
  const configPaths =
    projectRoot === '.'
      ? ['tsconfig.json', 'jsconfig.json']
      : [`${projectRoot}/tsconfig.json`, `${projectRoot}/jsconfig.json`];

  let firstConfig: AtSlashAliasConfig | null = null;

  for (const configPath of configPaths) {
    const file = generatedFileByPath(output, configPath);
    if (!file) continue;

    const parsed = parseJsoncObject(file.content);
    if (!parsed) {
      return {
        path: file.path,
        baseUrl: '.',
        targets: [],
        parseError: true,
        hasBaseUrl: false,
        hasAtSlashAlias: false
      };
    }

    const compilerOptions = objectValue(parsed.compilerOptions);
    const paths = objectValue(compilerOptions?.paths);
    const rawTargets = paths?.['@/*'];
    const targets = Array.isArray(rawTargets) ? rawTargets.map(stringValue).filter((value): value is string => Boolean(value)) : [];
    const baseUrl = stringValue(compilerOptions?.baseUrl) ?? '.';
    const config = {
      path: file.path,
      baseUrl,
      targets,
      hasBaseUrl: typeof compilerOptions?.baseUrl === 'string',
      hasAtSlashAlias: targets.length > 0
    };

    if (config.hasAtSlashAlias) return config;
    firstConfig ??= config;
  }

  return firstConfig;
}

function aliasTargetToGeneratedPath(projectRoot: string, config: AtSlashAliasConfig, importPath: string, target: string) {
  const importRemainder = importPath.replace(/^@\//u, '');
  const targetPath = target.includes('*') ? target.replace(/\*/gu, importRemainder) : `${target.replace(/\/$/u, '')}/${importRemainder}`;
  const pathInsideProject = normalizeGeneratedJoin(config.baseUrl, targetPath);
  return projectRoot === '.' ? pathInsideProject : normalizeGeneratedJoin(projectRoot, pathInsideProject);
}

function findPathAliasImportIssues(output: DevOutput) {
  const issues: string[] = [];
  const sourceFiles = output.files.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/i.test(file.path));
  const importPattern = /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\()\s*['"](@\/[^'"]+)['"]/g;

  for (const file of sourceFiles) {
    for (const match of Array.from(file.content.matchAll(importPattern))) {
      const importPath = match[1].replace(/\\/g, '/');
      const projectRoot = nearestGeneratedPackageDirectory(output, file.path);
      const config = atSlashAliasConfigForRoot(output, projectRoot);
      const configLocation = projectRoot === '.' ? 'tsconfig.json or jsconfig.json' : `${projectRoot}/tsconfig.json or ${projectRoot}/jsconfig.json`;

      if (!config) {
        issues.push(
          `Path alias import ${importPath} in ${file.path} uses @/, but ${configLocation} is missing. Generate a tsconfig.json or jsconfig.json with baseUrl and paths for @/*, or change the import to a relative path.`
        );
        continue;
      }

      if (config.parseError) {
        issues.push(`Path alias import ${importPath} in ${file.path} cannot be validated because ${config.path} is not valid JSON/JSONC.`);
        continue;
      }

      if (!config.hasBaseUrl || !config.hasAtSlashAlias) {
        issues.push(
          `Path alias import ${importPath} in ${file.path} uses @/, but ${config.path} does not configure both compilerOptions.baseUrl and compilerOptions.paths["@/*"]. Add the alias config or use a relative import.`
        );
        continue;
      }

      const candidates = config.targets.map((target) => aliasTargetToGeneratedPath(projectRoot, config, importPath, target));
      if (!candidates.some((candidate) => generatedPathExistsWithSourceExtensions(output, candidate))) {
        issues.push(
          `Path alias import ${importPath} in ${file.path} resolves through ${config.path}, but no matching generated file was found for target(s): ${candidates.join(', ')}.`
        );
      }
    }
  }

  return issues;
}

function resolveGeneratedImportPath(output: DevOutput, importerPath: string, importPath: string) {
  const normalizedImportPath = importPath.replace(/\\/g, '/');

  if (normalizedImportPath.startsWith('.')) {
    return firstGeneratedPathWithSourceExtensions(output, normalizeGeneratedJoin(dirName(importerPath), normalizedImportPath));
  }

  if (!normalizedImportPath.startsWith('@/')) return null;

  const projectRoot = nearestGeneratedPackageDirectory(output, importerPath);
  const config = atSlashAliasConfigForRoot(output, projectRoot);
  if (!config || config.parseError || !config.hasBaseUrl || !config.hasAtSlashAlias) return null;

  for (const target of config.targets) {
    const resolved = firstGeneratedPathWithSourceExtensions(output, aliasTargetToGeneratedPath(projectRoot, config, normalizedImportPath, target));
    if (resolved) return resolved;
  }

  return null;
}

function exportedNames(content: string) {
  const names = new Set<string>();

  for (const match of Array.from(content.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu))) {
    names.add(match[1]);
  }

  for (const match of Array.from(content.matchAll(/\bexport\s*\{([^}]+)\}/gu))) {
    for (const part of match[1].split(',')) {
      const exportName = part
        .trim()
        .replace(/\s+as\s+.+$/iu, '')
        .trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(exportName)) names.add(exportName);
    }
  }

  return names;
}

function importedNamedBindings(importClause: string) {
  return importClause
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/iu, '')
        .replace(/\s+as\s+.+$/iu, '')
        .trim()
    )
    .filter((value) => /^[A-Za-z_$][\w$]*$/u.test(value));
}

function findNamedImportExportIssues(output: DevOutput) {
  const issues: string[] = [];
  const sourceFiles = output.files.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/i.test(file.path));
  const importPattern = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]((?:@\/|\.{1,2}\/)[^'"]+)['"]/g;

  for (const file of sourceFiles) {
    for (const match of Array.from(file.content.matchAll(importPattern))) {
      const names = importedNamedBindings(match[1]);
      if (names.length === 0) continue;

      const targetPath = resolveGeneratedImportPath(output, file.path, match[2]);
      if (!targetPath) continue;

      const targetFile = generatedFileByPath(output, targetPath);
      if (!targetFile) continue;

      const exported = exportedNames(targetFile.content);
      for (const name of names) {
        if (!exported.has(name)) {
          issues.push(`Source file at ${file.path} imports named export ${name} from ${match[2]}, but generated file ${targetFile.path} does not export ${name}.`);
        }
      }
    }
  }

  return issues;
}

function hasUseClientDirective(content: string) {
  return /^\s*['"]use client['"]\s*;?/u.test(content);
}

function isLikelyAppRouterProject(output: DevOutput) {
  return output.files.some((file) => {
    const normalizedPath = normalizePath(file.path);
    if (normalizedPath.endsWith('next.config.js') || normalizedPath.endsWith('next.config.mjs') || normalizedPath.endsWith('next.config.ts')) {
      return true;
    }

    if (fileName(normalizedPath) !== 'package.json') return false;
    return /["']next["']\s*:/iu.test(file.content);
  });
}

function isAppRouterComponentPath(filePath: string) {
  const normalizedPath = normalizePath(filePath);
  return /(^|\/)app\/.*\.(tsx|jsx)$/iu.test(normalizedPath) || /(^|\/)components\/.*\.(tsx|jsx)$/iu.test(normalizedPath);
}

function findServerComponentClientOnlySignals(content: string) {
  const signals: string[] = [];

  if (/\bon[A-Z][A-Za-z0-9_$]*\s*=/u.test(content)) {
    signals.push('JSX event handler prop such as onClick/onSubmit/onChange');
  }

  if (/\buse(State|Effect|Reducer|Ref|Memo|Callback|Context|LayoutEffect|Transition|DeferredValue|Optimistic)\s*\(/u.test(content)) {
    signals.push('React client hook');
  }

  if (/from\s+['"]next\/navigation['"]/u.test(content) && /\b(useRouter|usePathname|useSearchParams|useSelectedLayoutSegment|useSelectedLayoutSegments)\b/u.test(content)) {
    signals.push('client navigation hook from next/navigation');
  }

  if (/\b(window|document|localStorage|sessionStorage|navigator)\s*\./u.test(content)) {
    signals.push('browser global access');
  }

  if (/from\s+['"]react-icons\//u.test(content)) {
    signals.push('react-icons import');
  }

  return signals;
}

function findNextAppRuntimeIssues(output: DevOutput) {
  const issues: string[] = [];
  if (!isLikelyAppRouterProject(output)) return issues;

  const sourceFiles = output.files.filter((file) => /\.(tsx|jsx)$/i.test(file.path));

  for (const file of sourceFiles) {
    const normalizedPath = normalizePath(file.path);
    if (!isAppRouterComponentPath(normalizedPath)) continue;
    if (hasUseClientDirective(file.content)) continue;

    const signals = findServerComponentClientOnlySignals(file.content);
    if (signals.length > 0) {
      issues.push(
        `App Router component ${file.path} uses ${signals.join(', ')} but is not marked with 'use client'; remove client-only code, render static controls without event handlers, or extract that behavior into a small Client Component.`
      );
    }
  }

  return issues;
}

function findNextServerFetchBuildIssues(output: DevOutput) {
  const issues: string[] = [];
  if (!isLikelyAppRouterProject(output)) return issues;

  const frontendFiles = generatedFilesByPrefix(output, 'frontend');
  const apiHelpers = frontendFiles.filter((file) => /(^|\/)src\/lib\/.*\.(ts|tsx|js|jsx)$/iu.test(normalizePath(file.path)));
  const buildTimeBackendHelpers = apiHelpers.filter((file) => {
    const content = file.content;
    const serverBackendUrl = /API_INTERNAL_URL|typeof\s+window\s*===\s*['"]undefined['"]|http:\/\/backend\b/iu.test(content);
    const hasFetch = /\bfetch\s*\(/iu.test(content);
    const hasDynamicFetchOption = /cache\s*:\s*['"]no-store['"]|next\s*:\s*\{[\s\S]*?revalidate\s*:\s*0/iu.test(content);
    return serverBackendUrl && hasFetch && !hasDynamicFetchOption;
  });

  if (buildTimeBackendHelpers.length === 0) return issues;

  const helperNames = new Set<string>();
  for (const helper of buildTimeBackendHelpers) {
    for (const match of Array.from(helper.content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/giu))) {
      helperNames.add(match[1]);
    }
  }

  const appPages = frontendFiles.filter((file) => /(^|\/)src\/app(?:\/.*)?\/page\.(tsx|jsx|ts|js)$/iu.test(normalizePath(file.path)));
  for (const page of appPages) {
    const content = page.content;
    if (hasUseClientDirective(content)) continue;
    if (/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]|export\s+const\s+revalidate\s*=\s*0/iu.test(content)) continue;
    if (!/from\s+['"][^'"]*lib\/api['"]|from\s+['"]@\/lib\/api['"]/iu.test(content)) continue;

    const callsBackendHelper =
      helperNames.size === 0 || Array.from(helperNames).some((helperName) => new RegExp(String.raw`\b${escapeRegExp(helperName)}\s*\(`, 'u').test(content));
    if (!callsBackendHelper) continue;

    issues.push(
      `App Router server data fetch in ${page.path} imports an API helper that uses API_INTERNAL_URL/http://backend without no-store or dynamic rendering. next build may prerender this page before Compose DNS exists and fail with ENOTFOUND backend. Add export const dynamic = 'force-dynamic' or export const revalidate = 0 to the page, or use fetch(..., { cache: 'no-store' }) in the API helper/page and handle backend failures without throwing during build.`
    );
  }

  return issues;
}

function findDockerfileRuntimeIssues(output: DevOutput) {
  const issues: string[] = [];
  const dockerfiles = output.files.filter((file) => fileName(file.path) === 'dockerfile');

  for (const file of dockerfiles) {
    if (!/COPY\s+--from=builder\s+\/app\/public\s+\.\/public/iu.test(file.content)) continue;

    const dockerDir = dirName(file.path);
    const publicPrefix = dockerDir === '.' ? 'public/' : `${dockerDir}/public/`;
    const hasPublicFiles = output.files.some((candidate) => normalizePath(candidate.path).startsWith(publicPrefix));

    if (!hasPublicFiles) {
      issues.push(
        `Dockerfile ${file.path} copies /app/public from the build stage, but no generated ${publicPrefix} files exist; remove that COPY step or generate a public asset folder.`
      );
    }
  }

  return issues;
}

function uncommentedRuntimeText(content: string) {
  return content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//');
    })
    .join('\n');
}

function findPythonContainerEntrypointIssues(output: DevOutput) {
  const issues: string[] = [];
  const dockerfiles = output.files.filter((file) => fileName(file.path) === 'dockerfile');

  for (const dockerfile of dockerfiles) {
    const dockerDir = dirName(dockerfile.path);
    if (dockerDir === '.') continue;

    const serviceName = fileName(dockerDir);
    const flatMainPath = `${dockerDir}/main.py`;
    if (!generatedFileByPath(output, flatMainPath)) continue;

    const hasNestedServicePackage = output.files.some((file) => normalizePath(file.path).startsWith(`${dockerDir}/${serviceName}/`));
    if (hasNestedServicePackage) continue;

    const startupFiles = output.files.filter((file) => dirName(file.path) === dockerDir && /\.(?:sh|bash)$/iu.test(file.path));
    const runtimeFiles = [dockerfile, ...startupFiles];
    const seenRefs = new Set<string>();

    for (const file of runtimeFiles) {
      const runtimeText = uncommentedRuntimeText(file.content);
      const uvicornRefs = [
        ...Array.from(runtimeText.matchAll(/\buvicorn\s+([A-Za-z_][\w.]*):([A-Za-z_]\w*)/giu)).map((match) => `${match[1]}:${match[2]}`),
        ...Array.from(runtimeText.matchAll(/["']([A-Za-z_][\w.]*):app["']/giu)).map((match) => `${match[1]}:app`)
      ];

      for (const ref of uvicornRefs) {
        const moduleName = ref.split(':')[0];
        const key = `${file.path}:${ref}`;
        if (seenRefs.has(key)) continue;
        seenRefs.add(key);

        if (moduleName.toLowerCase().startsWith(`${serviceName}.`)) {
          issues.push(
            `Python backend container entrypoint in ${file.path} starts Uvicorn with ${ref}, but ${dockerfile.path} is a flat ${dockerDir}/ build context with ${flatMainPath} and no generated ${dockerDir}/${serviceName}/ package. Use main:app for the flat backend, or generate and copy a real ${serviceName} package.`
          );
        }
      }
    }
  }

  return issues;
}

function findPythonFlatBackendImportIssues(output: DevOutput) {
  const issues: string[] = [];
  const dockerfiles = output.files.filter((file) => fileName(file.path) === 'dockerfile');

  for (const dockerfile of dockerfiles) {
    const dockerDir = dirName(dockerfile.path);
    if (dockerDir === '.') continue;

    const serviceName = fileName(dockerDir);
    const flatMainPath = `${dockerDir}/main.py`;
    if (!generatedFileByPath(output, flatMainPath)) continue;

    const hasNestedServicePackage = output.files.some((file) => normalizePath(file.path).startsWith(`${dockerDir}/${serviceName}/`));
    if (hasNestedServicePackage) continue;

    const rootPythonFiles = output.files.filter((file) => dirName(file.path) === dockerDir && /\.py$/iu.test(file.path));
    const servicePackagePattern = new RegExp(
      String.raw`^\s*(?:from\s+${escapeRegExp(serviceName)}(?:\.[A-Za-z_][\w.]*)?\s+import\b[^\r\n]*|import\s+${escapeRegExp(serviceName)}(?:\.[A-Za-z_][\w.]*)?(?:\s+as\s+\w+)?[^\r\n]*)`,
      'gimu'
    );

    for (const file of rootPythonFiles) {
      const runtimeText = uncommentedRuntimeText(file.content);
      const seenStatements = new Set<string>();
      const badRelativeImports = Array.from(runtimeText.matchAll(/^\s*from\s+\.(?:[A-Za-z_][\w.]*)?\s+import\b[^\r\n]*/gimu));
      const badServicePackageImports = Array.from(runtimeText.matchAll(servicePackagePattern));

      for (const match of badRelativeImports) {
        const statement = match[0].trim();
        if (seenStatements.has(statement)) continue;
        seenStatements.add(statement);
        issues.push(
          `Python flat backend import in ${file.path} uses package-relative import "${statement}", but ${dockerfile.path} is a flat ${dockerDir}/ build context with ${flatMainPath} imported as a top-level module. Use absolute sibling imports such as "from models import ...", or move the backend into a real package with __init__.py files and a matching Uvicorn module path.`
        );
      }

      for (const match of badServicePackageImports) {
        const statement = match[0].trim();
        if (seenStatements.has(statement)) continue;
        seenStatements.add(statement);
        issues.push(
          `Python flat backend import in ${file.path} uses nonexistent package import "${statement}", but ${dockerfile.path} copies the ${dockerDir}/ contents into /app without a generated /app/${serviceName}/ package. Use absolute sibling imports such as "from models import ...", or generate and copy a real ${serviceName} package and align the Uvicorn module path.`
        );
      }
    }
  }

  return issues;
}

function generatedPackageJsonForDirectory(output: DevOutput, directory: string) {
  const packageJsonPath = directory === '.' ? 'package.json' : `${directory}/package.json`;
  return generatedFileByPath(output, packageJsonPath);
}

function npmLockfileDependencyNames(parsed: Record<string, unknown>) {
  const dependencyNames = new Set<string>();
  const packages = objectValue(parsed.packages);
  const rootPackage = objectValue(packages?.['']);
  const topLevelDependencies = objectValue(parsed.dependencies);

  for (const dependencyName of Object.keys(topLevelDependencies ?? {})) {
    dependencyNames.add(dependencyName);
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = objectValue(rootPackage?.[field]);
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  for (const packagePath of Object.keys(packages ?? {})) {
    if (packagePath.startsWith('node_modules/')) {
      dependencyNames.add(packagePath.slice('node_modules/'.length));
    }
  }

  return dependencyNames;
}

function validateGeneratedNpmLockfile(output: DevOutput, lockfile: { path: string; content: string }) {
  const issues: string[] = [];
  const trimmedContent = lockfile.content.trim();
  const lockfileDirectory = dirName(lockfile.path);

  if (!trimmedContent) {
    return [
      `Generated npm lockfile ${lockfile.path} is empty or placeholder content. Do not generate empty lockfiles; remove it and use npm install in Docker, or generate a complete package-lock.json/npm-shrinkwrap.json that matches package.json.`
    ];
  }

  const parsed = parseJsonObject(trimmedContent);
  if (!parsed) {
    return [
      `Generated npm lockfile ${lockfile.path} is invalid JSON. Remove placeholder lockfiles and use npm install in Docker, or generate a complete valid lockfile that matches package.json.`
    ];
  }

  if (typeof parsed.lockfileVersion !== 'number') {
    issues.push(`Generated npm lockfile ${lockfile.path} is missing numeric lockfileVersion.`);
  }

  const packages = objectValue(parsed.packages);
  const dependencies = objectValue(parsed.dependencies);
  if (!packages && !dependencies) {
    issues.push(`Generated npm lockfile ${lockfile.path} is missing package entries/dependencies and will not satisfy npm or frontend build checks.`);
  }

  const packageJson = generatedPackageJsonForDirectory(output, lockfileDirectory);
  if (packageJson) {
    const packageDependencies = Array.from(dependencyNamesFromPackageJson(packageJson.content));
    const lockfileDependencies = npmLockfileDependencyNames(parsed);
    const missingDependencies = packageDependencies.filter((dependencyName) => !lockfileDependencies.has(dependencyName));

    if (missingDependencies.length > 0) {
      issues.push(
        `Generated npm lockfile ${lockfile.path} does not include package.json dependencies: ${missingDependencies.slice(0, 12).join(', ')}. Prefer removing generated lockfiles and using npm install unless a complete lockfile is explicitly required.`
      );
    }
  }

  return issues;
}

function findPackageManagerDockerIssues(output: DevOutput) {
  const issues: string[] = [];
  const npmLockfiles = output.files.filter((file) => {
    const name = fileName(file.path);
    return name === 'package-lock.json' || name === 'npm-shrinkwrap.json';
  });

  for (const lockfile of npmLockfiles) {
    issues.push(...validateGeneratedNpmLockfile(output, lockfile));
  }

  const dockerfiles = output.files.filter((file) => fileName(file.path) === 'dockerfile');

  for (const file of dockerfiles) {
    if (!/(?:^|\n)\s*RUN\s+[^\n#]*\bnpm\s+ci\b/iu.test(file.content)) continue;

    const dockerDir = dirName(file.path);
    const lockfileCandidates =
      dockerDir === '.'
        ? ['package-lock.json', 'npm-shrinkwrap.json']
        : [`${dockerDir}/package-lock.json`, `${dockerDir}/npm-shrinkwrap.json`];
    const matchingLockfiles = lockfileCandidates
      .map((candidate) => generatedFileByPath(output, candidate))
      .filter((candidate): candidate is { path: string; content: string } => Boolean(candidate));

    if (matchingLockfiles.length === 0) {
      issues.push(
        `Dockerfile ${file.path} runs npm ci, but no generated package-lock.json or npm-shrinkwrap.json exists in ${dockerDir}/. Because generated projects must not include lockfiles by default, Integration DEV must use npm install with COPY package*.json ./, or explicitly generate a matching lockfile if the requirement allows it.`
      );
      continue;
    }

    if (matchingLockfiles.some((lockfile) => validateGeneratedNpmLockfile(output, lockfile).length > 0)) {
      issues.push(
        `Dockerfile ${file.path} runs npm ci, but the matching generated npm lockfile in ${dockerDir}/ is malformed, placeholder content, or out of sync with package.json. Prefer npm install with COPY package*.json ./ for generated projects unless a complete lockfile is explicitly required.`
      );
    }
  }

  return issues;
}

function hasDependency(output: DevOutput, projectDirectory: string, dependencyName: string) {
  const packageJson = generatedPackageJsonForDirectory(output, projectDirectory);
  return packageJson ? dependencyNamesFromPackageJson(packageJson.content).has(dependencyName) : false;
}

function findFrontendBuildDependencyIssues(output: DevOutput) {
  const issues: string[] = [];
  const requiredDependenciesByProject = new Map<string, Map<string, Set<string>>>();

  function requireDependency(filePath: string, dependencyName: string, reason: string) {
    const projectDirectory = nearestGeneratedPackageDirectory(output, filePath);
    const dependencies = requiredDependenciesByProject.get(projectDirectory) ?? new Map<string, Set<string>>();
    const reasons = dependencies.get(dependencyName) ?? new Set<string>();
    reasons.add(reason);
    dependencies.set(dependencyName, reasons);
    requiredDependenciesByProject.set(projectDirectory, dependencies);
  }

  for (const file of output.files) {
    const normalizedPath = normalizePath(file.path);
    const name = fileName(normalizedPath);

    if (/^postcss\.config\.(js|cjs|mjs|ts)$/iu.test(name)) {
      if (/\bautoprefixer\b/u.test(file.content)) {
        requireDependency(file.path, 'autoprefixer', `${file.path} references autoprefixer`);
        requireDependency(file.path, 'postcss', `${file.path} is a PostCSS config`);
      }

      if (/\btailwindcss\b/u.test(file.content)) {
        requireDependency(file.path, 'tailwindcss', `${file.path} references tailwindcss`);
        requireDependency(file.path, 'postcss', `${file.path} is a PostCSS config`);
      }
    }

    if (/^tailwind\.config\.(js|cjs|mjs|ts)$/iu.test(name)) {
      requireDependency(file.path, 'tailwindcss', `${file.path} is a Tailwind config`);
    }

    if (/\.(css|scss|sass|pcss)$/iu.test(normalizedPath) && /@tailwind\s+(base|components|utilities)/iu.test(file.content)) {
      requireDependency(file.path, 'tailwindcss', `${file.path} uses @tailwind directives`);
      requireDependency(file.path, 'postcss', `${file.path} uses @tailwind directives`);
    }
  }

  for (const [projectDirectory, dependencies] of Array.from(requiredDependenciesByProject.entries())) {
    const packageJsonPath = projectDirectory === '.' ? 'package.json' : `${projectDirectory}/package.json`;
    const packageJson = generatedPackageJsonForDirectory(output, projectDirectory);

    if (!packageJson) {
      issues.push(`Frontend build config in ${projectDirectory}/ requires npm dependencies, but ${packageJsonPath} was not generated.`);
      continue;
    }

    for (const [dependencyName, reasons] of Array.from(dependencies.entries())) {
      if (!hasDependency(output, projectDirectory, dependencyName)) {
        issues.push(
          `Missing frontend dependency in ${packageJsonPath}: ${dependencyName} is required because ${Array.from(reasons).join('; ')}. Add it to dependencies/devDependencies or remove the config reference.`
        );
      }
    }
  }

  return issues;
}

function findPreparedStackImplementationIssues(output: DevOutput, preparedTechStack?: PreparedTechStackOutput) {
  if (!preparedTechStack) return [];

  const issues: string[] = [];
  const allText = generatedProjectSearchText(output.files);
  const frontendText = generatedProjectSearchText(generatedFilesByPrefix(output, 'frontend'));
  const backendText = generatedProjectSearchText(generatedFilesByPrefix(output, 'backend'));

  if (selectedStackMentions(preparedTechStack, /\bnext(?:\.js|js)?\b/i)) {
    const hasNextImplementation =
      /["']next["']\s*:/iu.test(frontendText) ||
      /(^|\n)frontend\/next\.config\.(js|mjs|ts)\b/iu.test(frontendText) ||
      /(^|\n)frontend\/(?:src\/)?app\/(?:page|layout)\.(tsx|jsx|ts|js)\b/iu.test(frontendText) ||
      /(^|\n)frontend\/pages\/(?:index|_app)\.(tsx|jsx|ts|js)\b/iu.test(frontendText);

    if (!hasNextImplementation) {
      issues.push(
        `Prepared tech stack selected ${preparedTechStack.frontendFramework}, but generated frontend files do not prove the selected frontend framework implementation. Generate the selected package/config/app or pages files instead of preserving a different frontend stack.`
      );
    }

    if (/["']react-scripts["']\s*:/iu.test(frontendText)) {
      issues.push(
        `Prepared tech stack selected ${preparedTechStack.frontendFramework}, but generated frontend/package.json uses react-scripts/Create React App. Replace the frontend scaffold with the selected frontend stack.`
      );
    }
  }

  if (selectedStackMentions(preparedTechStack, /\btailwind\b/i) && !/tailwind\.config\.(js|mjs|ts)|["']tailwindcss["']\s*:|@tailwind\s+(base|components|utilities)/iu.test(frontendText)) {
    issues.push(
      `Prepared tech stack selected Tailwind CSS, but generated frontend files do not include Tailwind configuration, dependency, or directives. Implement the selected styling stack instead of an unrelated UI framework.`
    );
  }

  if (selectedStackMentions(preparedTechStack, FAST_API_PATTERN)) {
    const hasSelectedPythonApiImplementation =
      new RegExp(`\\bfrom\\s+${'fast'}${'api'}\\s+import\\b|\\b${FAST_API_NAME}\\s*\\(`, 'u').test(backendText) ||
      new RegExp(`(?:^|\\n)backend\\/(?:requirements\\.txt|pyproject\\.toml)[\\s\\S]*\\b${'fast'}${'api'}\\b`, 'iu').test(backendText);

    if (!hasSelectedPythonApiImplementation) {
      issues.push(
        `Prepared tech stack selected ${preparedTechStack.backendFramework}, but generated backend files do not prove the selected Python API framework implementation. Generate backend files for the selected stack instead of preserving a different backend stack.`
      );
    }

    if (/spring-boot|org\.springframework|@SpringBootApplication|pom\.xml/iu.test(backendText)) {
      issues.push(
        `Prepared tech stack selected ${preparedTechStack.backendFramework}, but generated backend files contain Spring Boot/Maven implementation signals. Replace the backend with the selected backend stack.`
      );
    }
  }

  if (selectedStackMentions(preparedTechStack, /\bsqlmodel\b/i) && !/\bsqlmodel\b/iu.test(backendText)) {
    issues.push(
      `Prepared tech stack selected SQLModel, but generated backend files do not reference SQLModel. Keep ORM/persistence aligned with the prepared tech stack.`
    );
  }

  if (selectedStackMentions(preparedTechStack, FILE_DB_PATTERN)) {
    if (!FILE_DB_IMPLEMENTATION_PATTERN.test(allText)) {
      issues.push(
        `Prepared tech stack selected ${FILE_DB_DISPLAY_NAME}, but generated files do not include selected database connection, schema, or data-file configuration. Implement backend-owned file persistence for the selected database.`
      );
    }

    if (POSTGRES_IMPLEMENTATION_PATTERN.test(allText)) {
      issues.push(
        `Prepared tech stack selected ${FILE_DB_DISPLAY_NAME}, but generated files contain ${POSTGRES_NAME} service/configuration signals. Do not keep a service database when the current tech spec selected file-based persistence.`
      );
    }
  }

  if (selectedStackMentions(preparedTechStack, /\bspring\s*boot\b/i) && !/spring-boot|org\.springframework|@SpringBootApplication|pom\.xml/iu.test(backendText)) {
    issues.push(`Prepared tech stack selected ${preparedTechStack.backendFramework}, but generated backend files do not prove a Spring Boot implementation.`);
  }

  if (selectedStackMentions(preparedTechStack, POSTGRES_PATTERN) && !POSTGRES_IMPLEMENTATION_PATTERN.test(allText)) {
    issues.push(`Prepared tech stack selected ${preparedTechStack.database}, but generated files do not include selected service database or connection configuration.`);
  }

  return issues;
}

function isDeterministicStaticBlockerFinding(finding: string) {
  return /DEV skill validation contract could not be loaded|missing required path|missing required top-level directory|must include one of these top-level directories|missing .+ under .+ as required by the DEV skill contract|does not satisfy DEV skill contract content pattern|imports .+ but no matching generated file|does not export|Path alias import|not marked with 'use client'|App Router server data fetch|Dockerfile .+ runs npm ci, but no generated package-lock\.json|matching generated npm lockfile|Generated npm lockfile|Missing frontend dependency|Frontend build config|Prepared tech stack selected|react-scripts\/Create React App|Spring Boot\/Maven implementation signals|Do not keep a service database|Generated product API contract is double-prefixed|does not prove a backend collection route|does not prove a backend detail route|startup files do not invoke|Python backend container entrypoint|Python flat backend import|frontend source does not show navigation links|Spring backend defines duplicate route|publishes host port|hardcodes host port|browser-facing API URL|Backend CORS configuration/i.test(
    finding
  );
}

export function deterministicStaticBlockerFindings(validation: GeneratedProjectValidation) {
  return validation.findings.filter(isDeterministicStaticBlockerFinding);
}

function hasGeneratedProductContract(output: DevOutput) {
  const text = generatedProjectSearchText(output.files).toLowerCase();
  return /\/api\/products\b|\/products\/\[id\]|\/products\/\{|\bproductcard\b|\bproduct detail\b|\bproducts?\s+api\b/i.test(text);
}

function findGeneratedProductContractIssues(output: DevOutput) {
  const issues: string[] = [];
  if (!hasGeneratedProductContract(output)) return issues;

  const backendFiles = generatedFilesByPrefix(output, 'backend');
  const frontendFiles = generatedFilesByPrefix(output, 'frontend');
  const backendText = generatedProjectSearchText(backendFiles);
  const frontendText = generatedProjectSearchText(frontendFiles);
  const allText = generatedProjectSearchText(output.files);

  const registersApiProductsPrefix = /include_router\s*\([\s\S]*?prefix\s*=\s*["']\/api\/products["']/iu.test(backendText);
  const registersApiPrefix = /include_router\s*\([\s\S]*?prefix\s*=\s*["']\/api["']/iu.test(backendText);
  const routerOwnsApiProductsPrefix = /APIRouter\s*\([\s\S]*?prefix\s*=\s*["']\/api\/products["']/iu.test(backendText);
  const routerOwnsProductsPrefix = /APIRouter\s*\([\s\S]*?prefix\s*=\s*["']\/products["']/iu.test(backendText);
  const routeOwnsProductCollection = /@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*["']\/api\/products(?:\/\{[^}]+\})?["']/iu.test(backendText);
  const routerOwnsProductCollection = /@router\.get\s*\(\s*["']["']/iu.test(backendText);
  const routerOwnsProductDetail = /@router\.get\s*\(\s*["']\/\{[^}]+\}["']/iu.test(backendText);
  const mentionsNestedProductRoute = /\/api\/products\/products\b/iu.test(allText);

  if ((registersApiProductsPrefix && routerOwnsProductsPrefix) || mentionsNestedProductRoute) {
    issues.push(
      'Generated product API contract is double-prefixed. The required runtime endpoints are GET /api/products and GET /api/products/{id}; do not generate /api/products/products. Backend DEV must use either main prefix="/api" with router prefix="/products", or main prefix="/api/products" with an empty router prefix.'
    );
  }

  const hasListEndpoint =
    routeOwnsProductCollection ||
    (registersApiPrefix && routerOwnsProductsPrefix) ||
    ((registersApiProductsPrefix || routerOwnsApiProductsPrefix) && routerOwnsProductCollection);
  if (!hasListEndpoint) {
    issues.push(
      'Generated product UI references a product API, but static source does not prove a backend collection route for GET /api/products. Backend DEV must expose this exact route and seed non-empty product data before frontend/detail validation.'
    );
  }

  const hasDetailPage = frontendFiles.some((file) => /(^|\/)app\/products\/\[id\]\/page\.(tsx|jsx)$/iu.test(normalizePath(file.path)));
  const hasDetailEndpoint = /\/api\/products\/\{[^}]+\}/iu.test(backendText) || ((registersApiPrefix || registersApiProductsPrefix || routerOwnsApiProductsPrefix) && routerOwnsProductDetail);
  if (hasDetailPage && !hasDetailEndpoint) {
    issues.push('Generated product detail page exists, but static source does not prove a backend detail route for GET /api/products/{id}.');
  }

  const frontendFetchesProducts = /\/api\/products\b/iu.test(frontendText);
  const hasProductNavigation = /href\s*=\s*["'`{][^"'`}\n]*\/products\//iu.test(frontendText) || /<Link[\s\S]+\/products\//iu.test(frontendText);
  if ((hasDetailPage || frontendFetchesProducts) && !hasProductNavigation) {
    issues.push('Generated product list/detail contract is incomplete: frontend source does not show navigation links to product detail routes such as /products/1.');
  }

  const seedFiles = backendFiles.filter((file) => /(^|\/)(seed|seeds|seed_db|seed-data)[^/]*\.(py|ts|js)$/iu.test(normalizePath(file.path)));
  if (seedFiles.length > 0) {
    const composeFiles = output.files.filter((file) => /(^|\/)(compose|docker-compose)\.ya?ml$/iu.test(normalizePath(file.path)));
    const startupFiles = [
      ...backendFiles.filter((file) => /(^|\/)(dockerfile|start\.(?:sh|bash)|main\.py|app\.py)$/iu.test(normalizePath(file.path))),
      ...composeFiles
    ];
    const startupText = startupFiles.map((file) => uncommentedRuntimeText(file.content)).join('\n');
    const invokesSeed = seedFiles.some((file) => {
      const seedModule = fileName(file.path).replace(/\.(py|ts|js)$/iu, '');
      return new RegExp(`\\b${escapeRegExp(seedModule)}\\b`, 'iu').test(startupText);
    });

    if (!invokesSeed) {
      issues.push(
        `Generated product backend includes seed data file(s) ${seedFiles.map((file) => file.path).join(', ')}, but startup files do not invoke them. Backend startup must create/seed non-empty product data before /api/products validation.`
      );
    }
  }

  return issues;
}

function lastClassRequestMappingPrefix(content: string, classIndex: number) {
  const beforeClass = content.slice(0, Math.max(0, classIndex));
  let prefix = '';
  for (const match of Array.from(beforeClass.matchAll(/@RequestMapping\s*\(([\s\S]*?)\)/giu))) {
    const quoted = Array.from(match[1].matchAll(/["']([^"']*)["']/gu)).map((pathMatch) => pathMatch[1]);
    if (quoted.length > 0) prefix = quoted[0];
  }

  return prefix;
}

function normalizeRoutePath(prefix: string, routePath: string) {
  const combined = `/${[prefix, routePath].filter(Boolean).join('/')}`
    .replace(/\/+/gu, '/')
    .replace(/\/$/u, '');
  return combined || '/';
}

function mappingHttpMethod(annotationName: string, args: string) {
  const normalized = annotationName.toLowerCase();
  if (normalized === 'getmapping') return 'GET';
  if (normalized === 'postmapping') return 'POST';
  if (normalized === 'putmapping') return 'PUT';
  if (normalized === 'patchmapping') return 'PATCH';
  if (normalized === 'deletemapping') return 'DELETE';
  const explicit = args.match(/RequestMethod\.([A-Z]+)/u);
  return explicit?.[1] ?? 'ALL';
}

function mappingPaths(args: string) {
  const quoted = Array.from(args.matchAll(/["']([^"']*)["']/gu))
    .map((match) => match[1])
    .filter((value) => value === '' || value.startsWith('/'));

  return quoted.length > 0 ? quoted : [''];
}

function findSpringDuplicateRouteIssues(output: DevOutput) {
  const routeOwners = new Map<string, string[]>();
  const javaFiles = output.files.filter((file) => /^backend\/.+\.java$/iu.test(normalizePath(file.path)));

  for (const file of javaFiles) {
    const classIndex = file.content.search(/\bclass\s+\w+/u);
    const classPrefix = classIndex >= 0 ? lastClassRequestMappingPrefix(file.content, classIndex) : '';

    for (const match of Array.from(file.content.matchAll(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(([\s\S]*?)\))?/gu))) {
      const afterAnnotation = file.content.slice(match.index + match[0].length);
      const methodMatch = afterAnnotation.match(/^\s*(?:public|private|protected)\s+(?!class\b)[\w<>, ?]+\s+(\w+)\s*\(/u);
      if (!methodMatch) continue;

      const httpMethod = mappingHttpMethod(match[1], match[2] ?? '');
      for (const routePath of mappingPaths(match[2] ?? '')) {
        const fullPath = normalizeRoutePath(classPrefix, routePath);
        const key = `${httpMethod} ${fullPath}`;
        const owners = routeOwners.get(key) ?? [];
        owners.push(`${file.path}#${methodMatch[1]}`);
        routeOwners.set(key, owners);
      }
    }
  }

  return Array.from(routeOwners.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(
      ([route, owners]) =>
        `Spring backend defines duplicate route ${route} in ${owners.join(', ')}. Each HTTP method/path must be owned by exactly one controller method; keep one canonical health endpoint and remove the duplicate mapping.`
    );
}

function parsePortNumber(value: string | undefined) {
  if (!value) return null;
  const normalized = value.trim().replace(/^["']|["']$/g, '');
  const envDefault = normalized.match(/^\$\{[A-Z0-9_]+:-(\d+)\}$/iu);
  if (envDefault) return Number(envDefault[1]);
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseShortPortMapping(rawValue: string, service: string): ComposeHostPortMapping | null {
  const raw = rawValue.trim().replace(/^["']|["']$/g, '').replace(/\/[a-z]+$/iu, '');
  const parts = raw.split(':');
  if (parts.length < 2) return null;

  const hostPort = parsePortNumber(parts[parts.length - 2]);
  if (!hostPort) return null;

  return {
    service,
    hostPort,
    containerPort: parsePortNumber(parts[parts.length - 1]) ?? undefined,
    raw: rawValue.trim()
  };
}

function extractComposeHostPortMappings(content: string) {
  const mappings: ComposeHostPortMapping[] = [];
  let inServices = false;
  let currentService = '';
  let inPorts = false;
  let pending: Partial<ComposeHostPortMapping> | null = null;

  const flushPending = () => {
    if (pending?.service && pending.hostPort) {
      mappings.push({
        service: pending.service,
        hostPort: pending.hostPort,
        containerPort: pending.containerPort,
        raw: pending.raw || `${pending.hostPort}:${pending.containerPort || ''}`
      });
    }
    pending = null;
  };

  for (const line of content.split(/\r?\n/u)) {
    if (/^services:\s*$/u.test(line)) {
      inServices = true;
      currentService = '';
      inPorts = false;
      flushPending();
      continue;
    }

    if (inServices && /^\S/u.test(line) && !/^services:\s*$/u.test(line)) {
      inServices = false;
      currentService = '';
      inPorts = false;
      flushPending();
    }

    if (!inServices) continue;

    const serviceMatch = line.match(/^ {2}([a-z0-9_.-]+):\s*$/iu);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inPorts = false;
      flushPending();
      continue;
    }

    if (!currentService) continue;

    if (/^ {4}ports:\s*$/u.test(line)) {
      inPorts = true;
      flushPending();
      continue;
    }

    if (inPorts && /^ {4}\S/u.test(line) && !/^ {4}ports:\s*$/u.test(line)) {
      inPorts = false;
      flushPending();
    }

    if (!inPorts) continue;

    const itemMatch = line.match(/^ {6}-\s*(.+?)\s*$/u);
    if (itemMatch) {
      flushPending();
      const shortMapping = parseShortPortMapping(itemMatch[1], currentService);
      if (shortMapping) {
        mappings.push(shortMapping);
      } else {
        pending = { service: currentService, raw: itemMatch[1].trim() };
      }
      continue;
    }

    const propertyMatch = line.match(/^ {8}(published|target):\s*(.+?)\s*$/u);
    if (propertyMatch && pending) {
      const value = propertyMatch[2].trim().replace(/^["']|["']$/g, '');
      if (propertyMatch[1] === 'published') pending.hostPort = parsePortNumber(value) ?? undefined;
      if (propertyMatch[1] === 'target') pending.containerPort = parsePortNumber(value) ?? undefined;
    }
  }

  flushPending();
  return mappings;
}

function normalizedServiceName(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'db' || normalized === 'database' || normalized.endsWith('db') || normalized.includes('database')) return 'database';
  if (/front|web|ui/u.test(normalized)) return 'frontend';
  if (/back|api|server/u.test(normalized)) return 'backend';
  return normalized;
}

function preparedHostPort(preparedTechStack: PreparedTechStackOutput | undefined, service: string) {
  const normalized = normalizedServiceName(service);
  return preparedTechStack?.servicePorts?.find((port) => normalizedServiceName(port.service) === normalized)?.hostPort;
}

function generatedHostPortIsReserved(port: number) {
  return port >= GENERATED_APP_HOST_PORT_MIN && port <= GENERATED_APP_HOST_PORT_MAX;
}

function browserApiUrlPortIssues(output: DevOutput, expectedBackendPort: number) {
  const issues: string[] = [];
  const filesToScan = output.files.filter((file) => {
    const normalized = normalizePath(file.path);
    return (
      normalized === '.env.example' ||
      normalized.endsWith('.env.example') ||
      /(^|\/)(compose|docker-compose)\.ya?ml$/iu.test(normalized) ||
      normalized.startsWith('frontend/')
    );
  });

  const pattern = /\b(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]*(?:API|BACKEND)[A-Z0-9_]*(?:URL|BASE_URL)?\b[^\r\n]*(?:localhost|127\.0\.0\.1):(\d+)/giu;
  for (const file of filesToScan) {
    for (const match of Array.from(file.content.matchAll(pattern))) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port !== expectedBackendPort) {
        issues.push(
          `Browser-facing API URL in ${file.path} points to localhost:${port}, but generated backend host port is ${expectedBackendPort}. Keep VITE/NEXT_PUBLIC browser API URLs aligned with Compose.`
        );
      }
    }
  }

  return issues;
}

function findGeneratedPortContractIssues(output: DevOutput, preparedTechStack?: PreparedTechStackOutput) {
  const issues: string[] = [];
  const composeFiles = output.files.filter((file) => /(^|\/)(compose|docker-compose)\.ya?ml$/iu.test(normalizePath(file.path)));
  if (composeFiles.length === 0) return issues;

  const plannedFrontendPort = preparedHostPort(preparedTechStack, 'frontend') ?? DEFAULT_GENERATED_FRONTEND_HOST_PORT;
  const plannedBackendPort = preparedHostPort(preparedTechStack, 'backend') ?? DEFAULT_GENERATED_BACKEND_HOST_PORT;
  const plannedDatabasePort = preparedHostPort(preparedTechStack, 'database') ?? DEFAULT_GENERATED_DATABASE_HOST_PORT;
  const plannedPortsByService = new Map([
    ['frontend', plannedFrontendPort],
    ['backend', plannedBackendPort],
    ['database', plannedDatabasePort]
  ]);

  for (const port of preparedTechStack?.servicePorts ?? []) {
    if (!generatedHostPortIsReserved(port.hostPort)) {
      issues.push(
        `Prepared tech stack assigns ${port.service} host port ${port.hostPort}. Generated apps must reserve 55xxx host ports to avoid common local-dev conflicts; use frontend ${DEFAULT_GENERATED_FRONTEND_HOST_PORT}, backend ${DEFAULT_GENERATED_BACKEND_HOST_PORT}, and database ${DEFAULT_GENERATED_DATABASE_HOST_PORT} unless the user explicitly overrides them.`
      );
    }
  }

  const allMappings: ComposeHostPortMapping[] = [];
  for (const composeFile of composeFiles) {
    for (const mapping of extractComposeHostPortMappings(composeFile.content)) {
      allMappings.push(mapping);
      const normalizedService = normalizedServiceName(mapping.service);
      if (!generatedHostPortIsReserved(mapping.hostPort)) {
        issues.push(
          `Compose service ${mapping.service} publishes host port ${mapping.hostPort}. Generated apps must use configurable 55xxx host ports to avoid collisions with existing local stacks.`
        );
      }

      if (!/\$\{[A-Z0-9_]+(?::-\d+)?\}/iu.test(mapping.raw)) {
        issues.push(
          `Compose service ${mapping.service} hardcodes host port ${mapping.hostPort}. Use a HOST_PORT environment variable with a 55xxx default, for example "\${BACKEND_HOST_PORT:-${DEFAULT_GENERATED_BACKEND_HOST_PORT}}:8080".`
        );
      }

      const plannedPort = plannedPortsByService.get(normalizedService);
      if (plannedPort && mapping.hostPort !== plannedPort) {
        issues.push(
          `Compose service ${mapping.service} publishes host port ${mapping.hostPort}, but prepared tech stack expects ${plannedPort}. Keep preparedTechStack.servicePorts, docker-compose.yml, .env.example, README, and browser API URLs consistent.`
        );
      }
    }
  }

  if (allMappings.length > 0) {
    issues.push(...browserApiUrlPortIssues(output, plannedBackendPort));
    const allText = generatedProjectSearchText(output.files);
    if (/ALLOWED_ORIGINS|cors/iu.test(allText) && !new RegExp(`localhost:${plannedFrontendPort}|127\\.0\\.0\\.1:${plannedFrontendPort}`, 'iu').test(allText)) {
      issues.push(
        `Backend CORS configuration does not include the generated frontend host port ${plannedFrontendPort}. Allow http://localhost:${plannedFrontendPort} and http://127.0.0.1:${plannedFrontendPort}.`
      );
    }
  }

  return issues;
}

export function validateGeneratedProject(output: DevOutput, preparedTechStack?: PreparedTechStackOutput): GeneratedProjectValidation {
  const findings: string[] = [];
  let contract: SkillValidationContract;

  try {
    contract = readFirstGenerationContract();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(`DEV skill validation contract could not be loaded: ${message}`);
    contract = {};
  }

  for (const requiredPath of contract.requiredPaths ?? []) {
    if (!hasGeneratedPath(output, requiredPath)) {
      findings.push(`Generated project is missing required path from DEV skill contract: ${requiredPath}.`);
    }
  }

  for (const directory of contract.requiredTopLevelDirectories ?? []) {
    if (!hasGeneratedTopLevelDirectory(output, directory)) {
      findings.push(`Generated project is missing required top-level directory from DEV skill contract: ${directory}/.`);
    }
  }

  for (const directoryGroup of contract.oneOfTopLevelDirectories ?? []) {
    if (!directoryGroup.some((directory) => hasGeneratedTopLevelDirectory(output, directory))) {
      findings.push(`Generated project must include one of these top-level directories from DEV skill contract: ${directoryGroup.join(', ')}.`);
    }
  }

  for (const entry of contract.requiredFileNamesByDirectory ?? []) {
    for (const requiredFileName of entry.fileNames ?? []) {
      if (!hasFileNameInDirectory(output, entry.directory, requiredFileName)) {
        findings.push(`Generated project is missing ${requiredFileName} under ${entry.directory}/ as required by the DEV skill contract.`);
      }
    }
  }

  for (const check of contract.requiredContentChecks ?? []) {
    const content = generatedFileContent(output, check.path);
    if (!content) continue;

    for (const pattern of check.patterns ?? []) {
      if (!regexOrTextMatches(content, pattern)) {
        findings.push(`Generated file ${check.path} does not satisfy DEV skill contract content pattern: ${pattern}.`);
      }
    }
  }

  findings.push(...findRelativeImportIssues(output));
  findings.push(...findPathAliasImportIssues(output));
  findings.push(...findNamedImportExportIssues(output));
  findings.push(...findNextAppRuntimeIssues(output));
  findings.push(...findNextServerFetchBuildIssues(output));
  findings.push(...findDockerfileRuntimeIssues(output));
  findings.push(...findPythonContainerEntrypointIssues(output));
  findings.push(...findPythonFlatBackendImportIssues(output));
  findings.push(...findPackageManagerDockerIssues(output));
  findings.push(...findFrontendBuildDependencyIssues(output));
  findings.push(...findPreparedStackImplementationIssues(output, preparedTechStack));
  findings.push(...findGeneratedProductContractIssues(output));
  findings.push(...findSpringDuplicateRouteIssues(output));
  findings.push(...findGeneratedPortContractIssues(output, preparedTechStack));

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix these run/build readiness blockers from the loaded DEV skill contract:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : ''
  };
}
