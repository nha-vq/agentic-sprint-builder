import fs from 'fs/promises';
import path from 'path';
import { RUN_LIMITS } from '@/lib/config/limits';
import type { GeneratedFile, RunResult, RunStatusSnapshot } from '@/lib/types';

function getGeneratedRunsDir() {
  return path.resolve(process.cwd(), 'generated-runs');
}

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function validateRunId(runId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error('Invalid run id.');
  }
}

function getRunOutputDir(runId: string) {
  validateRunId(runId);
  return path.join(getGeneratedRunsDir(), runId);
}

function resolveGeneratedFilePath(base: string, target: string) {
  if (!target || target.includes('\0') || path.isAbsolute(target) || /^[a-zA-Z]:/.test(target)) {
    throw new Error(`Invalid generated file path: ${target}`);
  }

  const normalized = path.normalize(target);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Generated file path escapes output directory: ${target}`);
  }

  const destination = path.resolve(base, normalized);
  const relative = path.relative(base, destination);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Generated file path escapes output directory: ${target}`);
  }

  return destination;
}

function validateGeneratedFiles(files: GeneratedFile[]) {
  if (files.length > RUN_LIMITS.generatedFiles) {
    throw new Error(`Too many generated files. Limit is ${RUN_LIMITS.generatedFiles}.`);
  }

  let totalBytes = 0;
  for (const file of files) {
    const fileBytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += fileBytes;

    if (fileBytes > RUN_LIMITS.generatedFileBytes) {
      throw new Error(`Generated file ${file.path} exceeds ${RUN_LIMITS.generatedFileBytes} bytes.`);
    }
  }

  if (totalBytes > RUN_LIMITS.generatedTotalBytes) {
    throw new Error(`Generated files exceed ${RUN_LIMITS.generatedTotalBytes} total bytes.`);
  }
}

const TEXT_FILE_EXTENSIONS = new Set([
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.bash',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

function shouldCollectGeneratedTextFile(filePath: string) {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'dockerfile' || name === 'containerfile' || name === '.dockerignore' || name === '.env.example') return true;
  return TEXT_FILE_EXTENSIONS.has(path.extname(name));
}

async function collectFiles(dir: string, baseDir = dir): Promise<GeneratedFile[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: GeneratedFile[] = [];
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.next' ||
      entry.name === '.git' ||
      entry.name === '.venv' ||
      entry.name === '.runtime-logs' ||
      entry.name === '.validation-logs' ||
      entry.name === '.env' ||
      entry.name === '__pycache__' ||
      entry.name === '.pytest_cache'
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, baseDir)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!shouldCollectGeneratedTextFile(fullPath)) continue;

    const stat = await fs.stat(fullPath);
    if (stat.size > RUN_LIMITS.generatedFileBytes) continue;

    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    const content = await fs.readFile(fullPath, 'utf-8');
    files.push({ path: relativePath, content });
  }

  return files;
}

export async function readGeneratedCodeSnapshot() {
  const files = await collectFiles(getGeneratedCodeDir());
  const limitedFiles: GeneratedFile[] = [];
  let totalBytes = 0;

  for (const file of files.slice(0, RUN_LIMITS.generatedFiles)) {
    const fileBytes = Buffer.byteLength(file.content, 'utf8');
    if (totalBytes + fileBytes > RUN_LIMITS.generatedTotalBytes) break;

    totalBytes += fileBytes;
    limitedFiles.push(file);
  }

  return limitedFiles;
}

export async function writeGeneratedFiles(files: GeneratedFile[]) {
  validateGeneratedFiles(files);

  const outputDir = getGeneratedCodeDir();
  await fs.mkdir(outputDir, { recursive: true });

  for (const file of files) {
    const destination = resolveGeneratedFilePath(outputDir, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, 'utf-8');
  }

  return outputDir;
}

export async function saveRunResult(result: RunResult) {
  const outputDir = getRunOutputDir(result.runId);
  const resultWithOutputDir = { ...result, outputDir };

  await fs.mkdir(outputDir, { recursive: true });
  if (result.specArtifacts?.length) {
    for (const artifact of result.specArtifacts) {
      const specPath = artifact.path.startsWith('specs/') ? artifact.path : `specs/${path.basename(artifact.path)}`;
      const destination = resolveGeneratedFilePath(outputDir, specPath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, artifact.content, 'utf-8');
    }
  }
  await fs.writeFile(path.join(outputDir, 'run-result.json'), JSON.stringify(resultWithOutputDir, null, 2));
  await fs.writeFile(path.join(outputDir, 'BA_ARTIFACTS.md'), result.baOutput);
  await fs.writeFile(path.join(outputDir, 'QA_REPORT.md'), result.qaOutput);

  return outputDir;
}

export async function saveFailedRunSnapshot(snapshot: RunStatusSnapshot, error: unknown) {
  const outputDir = getRunOutputDir(snapshot.runId);
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    ...snapshot,
    outputDir,
    error: snapshot.error || message,
    failure: {
      message,
      stack: error instanceof Error ? error.stack : undefined,
      savedAt: new Date().toISOString()
    }
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'run-status.json'), JSON.stringify(payload, null, 2), 'utf-8');
  await fs.writeFile(
    path.join(outputDir, 'FAILURE_REPORT.md'),
    [
      `# Failed Run ${snapshot.runId}`,
      '',
      `Status: ${snapshot.status}`,
      `Current step: ${snapshot.currentStepId || 'unknown'}`,
      `Error: ${message}`,
      '',
      '## Logs',
      ...snapshot.logs.map((log) => `- ${log.timestamp} [${log.level}] ${log.message}`)
    ].join('\n'),
    'utf-8'
  );

  return outputDir;
}

export async function readRunResult(runId: string): Promise<RunResult | null> {
  try {
    const filePath = path.join(getRunOutputDir(runId), 'run-result.json');
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function listRunResults(): Promise<RunResult[]> {
  let entries;
  try {
    entries = await fs.readdir(getGeneratedRunsDir(), { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readRunResult(entry.name))
  );

  return results
    .filter((result): result is RunResult => result !== null)
    .sort((left, right) => right.runId.localeCompare(left.runId));
}
