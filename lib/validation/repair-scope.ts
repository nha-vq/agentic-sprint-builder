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
      return name === 'dockerfile' || name === 'containerfile' || /^compose\.ya?ml$/.test(name) || /^docker-compose\.ya?ml$/.test(name);
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

  return uniq(candidates.map((file) => file.path));
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

  if (/docker|compose|container|image|build context|failed to solve|service|port|startup|health|readiness|rancher/i.test(text)) {
    areas.add('docker');
  }

  if (/frontend\/|client|browser|ui|page|component|style|\.tsx\b|\.jsx\b|\.css\b|type error|compile/i.test(text)) {
    areas.add('frontend');
  }

  if (/backend\/|server|route|api|traceback|importerror|modulenotfounderror|\.py\b|entrypoint/i.test(text)) {
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
  if (kind === 'docker') {
    return `${generic} If a build/runtime log names application source files, fix those source files instead of only changing container files.`;
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
