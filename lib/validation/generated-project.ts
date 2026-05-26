import fs from 'node:fs';
import path from 'node:path';
import type { DevOutput } from '@/lib/types';

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

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
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

export function validateGeneratedProject(output: DevOutput): GeneratedProjectValidation {
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
  findings.push(...findNextAppRuntimeIssues(output));
  findings.push(...findDockerfileRuntimeIssues(output));

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix these run/build readiness blockers from the loaded DEV skill contract:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : ''
  };
}
