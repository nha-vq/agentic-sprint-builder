import type { GeneratedExecutionValidationResult, GeneratedFile, RepairScope, RepairScopeKind } from '@/lib/types';
import type { GeneratedProjectValidation } from './generated-project';

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function lowerPath(filePath: string) {
  return normalizePath(filePath).toLowerCase();
}

function uniq(paths: string[]) {
  const seen = new Set<string>();
  return paths
    .map(normalizePath)
    .filter((filePath) => {
      const key = filePath.toLowerCase();
      if (!filePath || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function fileName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return (index >= 0 ? normalized.slice(index + 1) : normalized).toLowerCase();
}

function dirName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function topDirectory(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.indexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function pathReferences(text: string) {
  const references: string[] = [];
  const patterns = [
    /(?:^|\s|["'`(])((?:\.\/)?[a-z0-9_.\-[\]@]+(?:\/[a-z0-9_.\-[\]@]+)+\.[a-z0-9]+)/gi,
    /(?:^|\s|["'`(])([a-z0-9_.\-[\]@]+(?:\/[a-z0-9_.\-[\]@]+)+)(?::\d+)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of Array.from(text.matchAll(pattern))) {
      references.push(normalizePath(match[1]));
    }
  }

  return uniq(references);
}

function fileIsReferenced(file: GeneratedFile, text: string, references: string[]) {
  const normalizedText = text.toLowerCase();
  const normalizedPath = lowerPath(file.path);
  const name = fileName(file.path);

  return (
    normalizedText.includes(normalizedPath) ||
    normalizedText.includes(name) ||
    references.some((reference) => {
      const normalizedReference = lowerPath(reference);
      return normalizedPath === normalizedReference || normalizedPath.endsWith(`/${normalizedReference}`) || normalizedReference.endsWith(`/${normalizedPath}`);
    })
  );
}

function toolingOrConfigFile(file: GeneratedFile) {
  const name = fileName(file.path);
  return (
    name === 'dockerfile' ||
    name === 'containerfile' ||
    /^compose\.ya?ml$/.test(name) ||
    /^docker-compose\.ya?ml$/.test(name) ||
    name === 'package.json' ||
    name === 'pyproject.toml' ||
    name === 'requirements.txt' ||
    name.endsWith('.sh') ||
    name.endsWith('.bash') ||
    name === 'readme.md' ||
    name === '.env.example' ||
    name.endsWith('.env.example')
  );
}

function candidatesForKind(files: GeneratedFile[], kind: RepairScopeKind, text: string) {
  const references = pathReferences(text);
  const referenced = files.filter((file) => fileIsReferenced(file, text, references));
  const candidates = [...referenced];

  const addMatching = (predicate: (file: GeneratedFile) => boolean) => {
    candidates.push(...files.filter(predicate));
  };

  if (kind === 'docker') {
    addMatching((file) => {
      const name = fileName(file.path);
      const normalized = lowerPath(file.path);
      return (
        name === 'dockerfile' ||
        name === 'containerfile' ||
        name.endsWith('.sh') ||
        name.endsWith('.bash') ||
        /^compose\.ya?ml$/.test(name) ||
        /^docker-compose\.ya?ml$/.test(name) ||
        (/module(?:not)?found|importerror|traceback|uvicorn|entrypoint|startup|flat backend import|package-relative import|nonexistent package import/i.test(text) &&
          normalized.startsWith('backend/') &&
          /\.(py|toml|txt)$/i.test(normalized))
      );
    });
  } else if (kind === 'frontend') {
    addMatching((file) => lowerPath(file.path).startsWith('frontend/') || /\.(tsx?|jsx?|css|scss|html|json)$/i.test(file.path));
  } else if (kind === 'backend') {
    addMatching((file) => lowerPath(file.path).startsWith('backend/') || /\.(py|ts|js|mjs|cjs|json|toml)$/i.test(file.path));
  } else if (kind === 'database') {
    addMatching((file) => /^(database|db)\//i.test(lowerPath(file.path)) || /(^|\/)(migrations?|schema|seed|init)/i.test(lowerPath(file.path)));
  } else if (kind === 'tests') {
    addMatching((file) => /(^|\/)(tests?|__tests__)\/|(\.|_)(test|spec)\./i.test(lowerPath(file.path)));
  } else if (kind === 'docs' || kind === 'config') {
    addMatching(toolingOrConfigFile);
  } else {
    addMatching((file) => toolingOrConfigFile(file) || /\.(tsx?|jsx?|py|css|json|ya?ml|mjs|cjs|toml|sql|md)$/i.test(file.path));
  }

  const candidatePaths = candidates.map((file) => file.path);
  if (kind === 'frontend') {
    for (const match of Array.from(text.matchAll(/\bfrontend\/public\/[a-z0-9_.\-\/]+/gi))) {
      candidatePaths.push(match[0].replace(/[.,;:)]+$/u, ''));
    }

    for (const match of Array.from(text.matchAll(/(?:^|[(/"'\s])\/images\/([a-z0-9_.\-\/]+)/gi))) {
      candidatePaths.push(`frontend/public/images/${match[1].replace(/[.,;:)]+$/u, '')}`);
    }

    if (/next build|prerender|ENOTFOUND\s+backend|Export encountered errors|server data fetch|API_INTERNAL_URL|http:\/\/backend/i.test(text)) {
      for (const file of files.filter((file) => {
        const normalized = lowerPath(file.path);
        return (
          normalized.startsWith('frontend/src/app/') ||
          normalized.startsWith('frontend/src/lib/') ||
          normalized === 'frontend/package.json' ||
          normalized === 'frontend/next.config.js' ||
          normalized === 'frontend/dockerfile'
        );
      })) {
        candidatePaths.push(file.path);
      }
    }
  }

  return uniq(candidatePaths);
}

function dynamicDirectories(files: GeneratedFile[], candidatePaths: string[]) {
  if (candidatePaths.length > 0) return uniq(candidatePaths.map(dirName));
  return uniq([...files.map((file) => topDirectory(file.path)), '.']);
}

function createScope(params: {
  kind: RepairScopeKind;
  label: string;
  instructions: string;
  text: string;
  files: GeneratedFile[];
  requiresPlanning?: boolean;
}): RepairScope {
  const candidatePaths = candidatesForKind(params.files, params.kind, params.text);
  return {
    kind: params.kind,
    label: params.label,
    instructions: params.instructions,
    candidatePaths,
    allowedDirectories: dynamicDirectories(params.files, candidatePaths),
    requiresPlanning: params.requiresPlanning
  };
}

export function formatRepairScope(scope?: RepairScope) {
  if (!scope) return 'No scoped repair constraints.';

  return [
    `Repair scope: ${scope.label} (${scope.kind})`,
    scope.instructions,
    scope.requiresPlanning ? 'This repair may create new files inside the allowed directories.' : 'Prefer editing the candidate files. Create new files only when the failure cannot be fixed by editing candidates.',
    'Candidate files from generated-code snapshot/logs:',
    ...(scope.candidatePaths.length ? scope.candidatePaths.map((filePath) => `- ${filePath}`) : ['- No direct candidate file was detected.']),
    'Allowed generated-code directories:',
    ...scope.allowedDirectories.map((directory) => `- ${directory}`)
  ].join('\n');
}

function validationText(validation: GeneratedExecutionValidationResult) {
  const failedSteps = validation.steps.filter((step) => step.status === 'FAIL');
  return [
    validation.findings.join('\n'),
    ...failedSteps.map((step) => `${step.name}\n${step.command || ''}\n${step.message}`)
  ].join('\n');
}

function repairAreas(text: string) {
  const areas = new Set<RepairScopeKind>();

  if (/broken image|static image asset|rendered image|naturalWidth=0|frontend\/public\/|\/images\/|image signature|image asset|mime\/extension|content-type/i.test(text)) {
    areas.add('frontend');
  }

  if (/docker|compose|container image|build context|failed to solve|service|port|startup|health|readiness|rancher/i.test(text)) {
    areas.add('docker');
  }

  if (/frontend\/|client|browser|ui|page|component|style|\.tsx\b|\.jsx\b|\.css\b|type error|compile/i.test(text)) {
    areas.add('frontend');
  }

  if (
    /backend\/|server|route|api|traceback|importerror|modulenotfounderror|\.py\b|entrypoint|Ambiguous mapping|Cannot map .* method|BeanCreationException|Application run failed|Error starting ApplicationContext|\.java\b|controller|@(?:Get|Post|Put|Patch|Delete|Request)Mapping/i.test(
      text
    )
  ) {
    areas.add('backend');
  }

  if (/database|db_|database_url|connection string|migration|schema|seed|data init/i.test(text)) {
    areas.add('database');
  }

  if (/readme|\.env|environment|setup|instructions|config/i.test(text)) {
    areas.add('docs');
  }

  if (/tests?|spec|smoke/i.test(text)) {
    areas.add('tests');
  }

  return areas;
}

function firstAreaOrUnknown(text: string): RepairScopeKind {
  if (/Next\.js App Router server data fetch|next build[\s\S]*ENOTFOUND\s+backend|prerender(?:ing)? page|Export encountered errors|fetch failed[\s\S]*hostname:\s*['"]backend['"]/i.test(text)) {
    return 'frontend';
  }

  if (
    /Python flat backend import|ImportError:\s+attempted relative import|ModuleNotFoundError:\s+No module named ['"]backend['"]|package-relative import|nonexistent package import/i.test(text) &&
    /backend|\.py\b|uvicorn|traceback|docker|compose/i.test(text)
  ) {
    return 'docker';
  }

  if (
    /imports .+ but no matching generated file|relative import|Path alias import|tsconfig\.json|jsconfig\.json|compilerOptions\.paths|Missing frontend dependency|Generated npm lockfile|package-lock\.json|postcss\.config|tailwind\.config/i.test(
      text
    )
  ) {
    return 'frontend';
  }

  if (/broken image|static image asset|rendered image|naturalWidth=0|frontend\/public\/|\/images\/|image signature|image asset|mime\/extension|content-type/i.test(text)) {
    return 'frontend';
  }

  if (/\/api\/[^ \n"'`]+.*(?:404|not found)|(?:404|not found).*\/api\/|double-prefixed|double prefix|route contract|backend collection route|backend detail route|\/api\/products\/products|APIRouter|include_router/i.test(text)) {
    return 'backend';
  }

  if (
    /Ambiguous mapping|Cannot map .* method|There is already .* mapped|BeanCreationException|Application run failed|Error starting ApplicationContext|\.java\b|controller|@(?:Get|Post|Put|Patch|Delete|Request)Mapping/i.test(
      text
    )
  ) {
    return 'backend';
  }

  if (/browser DOM|hydration|product cards?|detail route|frontend browser|visible route|homepage|page failed|_next\/image/i.test(text)) {
    return 'frontend';
  }

  if (/docker|compose|container image|build context|failed to solve|service|port|startup|health|readiness|rancher/i.test(text)) {
    return 'docker';
  }

  return Array.from(repairAreas(text))[0] ?? 'unknown';
}

function singleAreaOrUnknown(text: string): RepairScopeKind {
  const areas = Array.from(repairAreas(text));
  return areas.length === 1 ? areas[0] : 'unknown';
}

function scopeLabel(kind: RepairScopeKind, prefix: string) {
  const labels: Record<RepairScopeKind, string> = {
    initial: `${prefix} initial repair`,
    docker: `${prefix} container/build repair`,
    frontend: `${prefix} frontend repair`,
    backend: `${prefix} backend repair`,
    database: `${prefix} data repair`,
    tests: `${prefix} test/smoke repair`,
    docs: `${prefix} docs/env repair`,
    config: `${prefix} config repair`,
    unknown: `${prefix} focused repair`
  };
  return labels[kind];
}

function scopeInstructions(kind: RepairScopeKind) {
  const generic = 'Use the loaded DEV skill, exact findings/logs, generated project overview, and candidate files to make the smallest useful generated-code repair. Preserve unrelated files and requirement-relevant behavior.';
  if (kind === 'backend') {
    return `${generic} For API 404 or route-contract failures, first verify the backend route registration and route prefixes. Expose the exact endpoints consumed by frontend code before changing frontend fallbacks or container files.`;
  }
  if (kind === 'frontend') {
    return `${generic} For unresolved local imports, fix the import path based on the source file depth and generated file tree; for example, frontend/src/app/products/[id]/page.tsx must use ../../../lib/api to reach frontend/src/lib/api.ts, or use a configured @/ alias. For path alias failures, generate valid JSON in frontend/tsconfig.json or frontend/jsconfig.json with compilerOptions.baseUrl and compilerOptions.paths["@/*"], or replace @/ imports with relative imports. For app-router prerender/build failures caused by server fetches to Compose DNS such as http://backend, make the page dynamic with export const dynamic = 'force-dynamic' or export const revalidate = 0, or use fetch(..., { cache: 'no-store' }) and handle backend failures without throwing during next build. For broken rendered images or static asset signature failures, fix the frontend asset references and files together: do not save SVG/XML text with raster extensions, and keep public URLs aligned with files the browser can decode.`;
  }
  if (kind === 'docker') {
    return `${generic} If a build/runtime log names application source files, fix those source files instead of only changing container files. For Python API startup failures, align Uvicorn module paths and imports with the Docker build context: a flat ./backend context copied into /app should usually start main:app, not backend.main:app, and root Python files in that flat context must use absolute sibling imports such as "from models import Product", not "from .models" or "from backend.models", unless a real backend package is copied into the image. If generated product seed files exist, startup must invoke an idempotent seed/schema path before the service becomes healthy; README-only seed instructions do not satisfy runtime validation. For host-port conflicts, do not ask validation to stop unrelated containers; move generated Compose host bindings and browser API URLs to configurable 55xxx ports such as frontend 55001, backend 55080, and database 55432.`;
  }
  return generic;
}

export function inferExecutionRepairScope(validation: GeneratedExecutionValidationResult, files: GeneratedFile[]): RepairScope {
  const text = validationText(validation);
  const kind = firstAreaOrUnknown(text);
  return createScope({
    kind,
    label: scopeLabel(kind, 'Execution'),
    instructions: scopeInstructions(kind),
    text,
    files,
    requiresPlanning: true
  });
}

export function inferStaticRepairScope(validation: GeneratedProjectValidation, files: GeneratedFile[]): RepairScope {
  const text = `${validation.findings.join('\n')}\n${validation.fixInstructions}`;
  const kind = firstAreaOrUnknown(text);
  return createScope({
    kind,
    label: scopeLabel(kind, 'Static readiness'),
    instructions: scopeInstructions(kind),
    text,
    files,
    requiresPlanning: true
  });
}

export function inferQaRepairScope(qaFeedback: string, files: GeneratedFile[]): RepairScope {
  const kind = firstAreaOrUnknown(qaFeedback);
  return createScope({
    kind,
    label: scopeLabel(kind, 'QA'),
    instructions: scopeInstructions(kind),
    text: qaFeedback,
    files,
    requiresPlanning: true
  });
}

export function inferReviewRepairScope(reviewFeedback: string, files: GeneratedFile[]): RepairScope {
  const kind = singleAreaOrUnknown(reviewFeedback);
  return createScope({
    kind,
    label: scopeLabel(kind, 'CodeReview/Deploy'),
    instructions: scopeInstructions(kind),
    text: reviewFeedback,
    files,
    requiresPlanning: true
  });
}
