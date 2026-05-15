import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readGeneratedCodeSnapshot } from '@/lib/storage/file-writer';
import { inferExecutionRepairScope } from './repair-scope';
import type { GeneratedExecutionValidationResult, GeneratedValidationStep, RunProgressReporter } from '@/lib/types';

const COMMAND_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 45_000;
const LOG_TAIL_CHARS = 8_000;
const COMPOSE_PROJECT_NAME = 'agentic-sprint-builder-generated';

interface CommandResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface ComposeEngine {
  name: 'docker compose' | 'nerdctl compose';
  command: string;
  baseArgs: string[];
}

const COMPOSE_ENGINES: ComposeEngine[] = [
  { name: 'docker compose', command: 'docker', baseArgs: ['compose'] },
  { name: 'nerdctl compose', command: 'nerdctl', baseArgs: ['compose'] }
];

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function createValidationWorkspacePath() {
  return path.resolve(process.cwd(), 'generated-runs', '.validation-workspaces', Date.now().toString());
}

function commandName(name: string) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function getPythonCommand() {
  return process.env.PYTHON || 'python';
}

function getBackendPort() {
  return Number(process.env.GENERATED_BACKEND_PORT || 8000);
}

function getFrontendPort() {
  return Number(process.env.GENERATED_FRONTEND_PORT || 3001);
}

function shouldValidateExecution() {
  return process.env.VALIDATE_GENERATED_EXECUTION !== 'false';
}

function allowDockerValidation() {
  return process.env.ALLOW_GENERATED_DOCKER !== 'false';
}

function getPreferredComposeEngine() {
  const raw = process.env.GENERATED_COMPOSE_ENGINE?.trim().toLowerCase();
  if (raw === 'docker') return 'docker compose';
  if (raw === 'nerdctl') return 'nerdctl compose';
  return 'auto';
}

function maskSecrets(value: string) {
  return value
    .replace(/(api[_-]?key|token|secret|password)(["'\s:=]+)([^"'\s]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}

function truncate(value: string, maxChars = LOG_TAIL_CHARS) {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipWorkspaceEntry(entryName: string) {
  return [
    'node_modules',
    '.next',
    '.git',
    '.venv',
    '.runtime-logs',
    '.validation-logs',
    '.env',
    '__pycache__',
    '.pytest_cache'
  ].includes(entryName);
}

async function copyDirectoryForValidation(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry.name)) continue;

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryForValidation(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function readJsonFile<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function findFilesByName(dir: string, names: string[], ignored = new Set(['node_modules', '.next', '.git', '.venv', '.runtime-logs', '.validation-logs', '__pycache__', '.pytest_cache'])): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFilesByName(fullPath, names, ignored)));
    } else if (entry.isFile() && names.includes(entry.name.toLowerCase())) {
      matches.push(fullPath);
    }
  }

  return matches;
}

async function findNearestManifestDir(codeDir: string, names: string[], contentPattern?: RegExp) {
  const manifests = await findFilesByName(codeDir, names.map((name) => name.toLowerCase()));
  for (const manifest of manifests) {
    if (!contentPattern) return path.dirname(manifest);
    const content = await fs.readFile(manifest, 'utf-8');
    if (contentPattern.test(content)) return path.dirname(manifest);
  }

  return null;
}

async function writeLog(logDir: string, name: string, content: string) {
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  await fs.writeFile(logFile, maskSecrets(content || '(no output)'), 'utf-8');
  return logFile;
}

function runCommand(command: string, args: string[], cwd: string, timeout = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve({
        ok: !error,
        output,
        error: error instanceof Error ? error.message : undefined
      });
    });
  });
}

async function commandStep(params: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  logDir: string;
  timeout?: number;
  onProgress?: RunProgressReporter;
}): Promise<GeneratedValidationStep> {
  const commandText = [params.command, ...params.args].join(' ');
  await params.onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Running: ${commandText}`
  });

  const result = await runCommand(params.command, params.args, params.cwd, params.timeout);
  const logFile = await writeLog(params.logDir, params.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(), result.output);
  await params.onProgress?.({
    stepId: 'execution-validation',
    stepStatus: result.ok ? 'RUNNING' : 'FAIL',
    level: result.ok ? 'success' : 'error',
    message: result.ok ? `${params.name} completed.` : `${params.name} failed. See ${logFile}.`
  });

  return {
    name: params.name,
    status: result.ok ? 'PASS' : 'FAIL',
    command: commandText,
    logFile,
    message: result.ok ? 'Command completed successfully.' : `${result.error || 'Command failed.'}\n${truncate(maskSecrets(result.output), 1200)}`
  };
}

function skippedStep(name: string, message: string, command?: string): GeneratedValidationStep {
  return {
    name,
    status: 'SKIPPED',
    command,
    message
  };
}

async function resolveComposeFile(codeDir: string) {
  for (const fileName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await pathExists(path.join(codeDir, fileName))) return fileName;
  }

  return null;
}

async function copyEnvExampleIfSafe(codeDir: string): Promise<GeneratedValidationStep> {
  const envExample = path.join(codeDir, '.env.example');
  const envFile = path.join(codeDir, '.env');

  if (!(await pathExists(envExample))) {
    return skippedStep('prepare env', 'No root .env.example file was generated.');
  }

  if (await pathExists(envFile)) {
    return skippedStep('prepare env', 'Root .env already exists; validation did not overwrite it.');
  }

  const content = await fs.readFile(envExample, 'utf-8');
  await fs.writeFile(envFile, content, 'utf-8');

  return {
    name: 'prepare env',
    status: 'PASS',
    command: 'copy .env.example .env',
    message: 'Created generated-code/.env from .env.example for local validation.'
  };
}

async function waitForHttp(name: string, urls: string[], timeoutMs = HEALTH_TIMEOUT_MS, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep> {
  const startedAt = Date.now();
  let lastMessage = '';
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Checking ${name}: ${urls.join(' or ')}`
  });

  while (Date.now() - startedAt < timeoutMs) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const body = await response.text();
        if (response.ok) {
          await onProgress?.({
            stepId: 'execution-validation',
            stepStatus: 'RUNNING',
            level: 'success',
            message: `${name} passed at ${url}.`
          });
          return {
            name,
            status: 'PASS',
            command: `GET ${url}`,
            message: `${url} returned ${response.status}${body ? `: ${truncate(body, 500)}` : ''}`
          };
        }

        lastMessage = `${url} returned ${response.status}: ${truncate(body, 500)}`;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return {
    name,
    status: 'FAIL',
    command: urls.map((url) => `GET ${url}`).join(' || '),
    message: lastMessage || `Health check did not pass within ${timeoutMs}ms.`
  };
}

async function collectComposeLogsForEngine(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string) {
  const args = [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'];
  if (engine.name === 'docker compose') args.splice(args.length - 1, 0, '--no-color');
  const result = await runCommand(engine.command, args, codeDir);
  return writeLog(logDir, `${engine.name.replace(/\s+/g, '-')}-logs`, result.output);
}

function getComposeEnginesToTry() {
  const preferred = getPreferredComposeEngine();
  if (preferred === 'auto') return COMPOSE_ENGINES;
  return COMPOSE_ENGINES.filter((engine) => engine.name === preferred);
}

async function validateWithDockerCompose(codeDir: string, composeFile: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const steps: GeneratedValidationStep[] = [];

  if (!allowDockerValidation()) {
    steps.push(skippedStep('docker compose validation', 'ALLOW_GENERATED_DOCKER=false; Docker Compose execution was skipped.'));
    return steps;
  }

  const engines = getComposeEnginesToTry();
  if (engines.length === 0) {
    steps.push(skippedStep('compose validation', `Unsupported GENERATED_COMPOSE_ENGINE=${process.env.GENERATED_COMPOSE_ENGINE}. Use auto, docker, or nerdctl.`));
    return steps;
  }

  for (const engine of engines) {
    const version = await commandStep({
      name: `${engine.name} version`,
      command: engine.command,
      args: [...engine.baseArgs, 'version'],
      cwd: codeDir,
      logDir,
      onProgress
    });

    if (version.status === 'FAIL') {
      steps.push({
        ...version,
        status: 'SKIPPED',
        message: `${engine.name} is not available for execution validation on this machine. ${version.message}`
      });
      continue;
    }
    steps.push(version);

    const config = await commandStep({
      name: `${engine.name} config`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'],
      cwd: codeDir,
      logDir,
      onProgress
    });
    steps.push(config);
    if (config.status === 'FAIL') return steps;

    const up = await commandStep({
      name: `${engine.name} up`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'up', '-d', '--build'],
      cwd: codeDir,
      logDir,
      timeout: 300_000,
      onProgress
    });
    steps.push(up);

    if (up.status === 'FAIL') {
      const logFile = await collectComposeLogsForEngine(engine, codeDir, composeFile, logDir);
      steps.push({
        name: `${engine.name} logs`,
        status: 'FAIL',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')}`,
        logFile,
        message: `Captured ${engine.name} logs after startup failure.`
      });
      return steps;
    }

    steps.push(
      await waitForHttp('backend health', [
        `http://127.0.0.1:${getBackendPort()}/health`,
        `http://localhost:${getBackendPort()}/health`
      ], HEALTH_TIMEOUT_MS, onProgress)
    );
    steps.push(await waitForHttp('frontend health', [`http://127.0.0.1:${getFrontendPort()}/`, `http://localhost:${getFrontendPort()}/`], HEALTH_TIMEOUT_MS, onProgress));

    const backendTestsExist = (await pathExists(path.join(codeDir, 'backend', 'tests'))) || (await pathExists(path.join(codeDir, 'backend', 'app', 'tests')));
    if (backendTestsExist) {
      steps.push(
        await commandStep({
          name: 'backend tests',
          command: engine.command,
          args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'exec', '-T', 'backend', 'pytest'],
          cwd: codeDir,
          logDir,
          timeout: 180_000,
          onProgress
        })
      );
    } else {
      steps.push(skippedStep('backend tests', 'No backend tests directory was generated.'));
    }

    const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(path.join(codeDir, 'frontend', 'package.json'));
    if (packageJson?.scripts?.test) {
      steps.push(
        await commandStep({
          name: 'frontend tests',
          command: engine.command,
          args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'exec', '-T', 'frontend', 'npm', 'test'],
          cwd: codeDir,
          logDir,
          timeout: 180_000,
          onProgress
        })
      );
    } else {
      steps.push(skippedStep('frontend tests', 'No frontend test script was generated.'));
    }

    return steps;
  }

  return steps;
}

async function validateLocalNode(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const frontendDir = await findNearestManifestDir(codeDir, ['package.json'], /next|react|vite/i);
  if (!frontendDir) return [skippedStep('frontend local validation', 'No generated frontend package manifest was found.')];
  const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(path.join(frontendDir, 'package.json'));
  if (!packageJson) return [skippedStep('frontend local validation', 'Generated frontend package manifest could not be parsed.')];

  const steps: GeneratedValidationStep[] = [];
  const npm = commandName('npm');
  steps.push(await commandStep({ name: 'frontend install', command: npm, args: ['install'], cwd: frontendDir, logDir, timeout: 300_000, onProgress }));

  for (const script of ['lint', 'test', 'build']) {
    if (packageJson.scripts?.[script]) {
      steps.push(await commandStep({ name: `frontend ${script}`, command: npm, args: ['run', script], cwd: frontendDir, logDir, onProgress }));
    } else {
      steps.push(skippedStep(`frontend ${script}`, `Generated frontend package manifest has no ${script} script.`));
    }
  }

  return steps;
}

async function validateLocalPython(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const backendDir = await findNearestManifestDir(codeDir, ['requirements.txt', 'pyproject.toml'], /fastapi|uvicorn|sqlmodel|pytest/i);
  if (!backendDir) return [skippedStep('backend local validation', 'No generated backend dependency manifest was found.')];
  const requirements = path.join(backendDir, 'requirements.txt');
  if (!(await pathExists(requirements))) return [skippedStep('backend local validation', 'Generated backend does not use requirements.txt; Python local validation currently supports requirements.txt only.')];

  const python = getPythonCommand();
  const venvDir = path.join(backendDir, '.venv');
  const venvPython = process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  const steps: GeneratedValidationStep[] = [];

  if (!(await pathExists(venvPython))) {
    steps.push(await commandStep({ name: 'backend venv', command: python, args: ['-m', 'venv', '.venv'], cwd: backendDir, logDir, onProgress }));
    if (steps[steps.length - 1].status === 'FAIL') return steps;
  }

  steps.push(await commandStep({ name: 'backend install', command: venvPython, args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], cwd: backendDir, logDir, timeout: 300_000, onProgress }));

  const testsExist = (await pathExists(path.join(backendDir, 'tests'))) || (await pathExists(path.join(backendDir, 'app', 'tests')));
  if (testsExist) {
    steps.push(await commandStep({ name: 'backend tests', command: venvPython, args: ['-m', 'pytest'], cwd: backendDir, logDir, onProgress }));
  } else {
    steps.push(skippedStep('backend tests', 'No backend tests directory was generated.'));
  }

  return steps;
}

function buildResult(params: {
  startedAt: string;
  workspace: string;
  steps: GeneratedValidationStep[];
  skipped?: boolean;
}): GeneratedExecutionValidationResult {
  const failedSteps = params.steps.filter((step) => step.status === 'FAIL');
  const executionSteps = params.steps.filter((step) => step.name !== 'prepare env');
  const allExecutionSkipped = executionSteps.length > 0 && executionSteps.every((step) => step.status === 'SKIPPED');
  const findings = failedSteps.map((step) => `${step.name}: ${step.message}`);
  const status = params.skipped || allExecutionSkipped ? 'SKIPPED' : failedSteps.length > 0 ? 'NEEDS_FIX' : 'PASS';

  return {
    status,
    startedAt: params.startedAt,
    finishedAt: new Date().toISOString(),
    workspace: params.workspace,
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix generated project validation failures:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : '',
    steps: params.steps
  };
}

async function addRepairScope(result: GeneratedExecutionValidationResult) {
  if (result.status !== 'NEEDS_FIX') return result;
  const files = await readGeneratedCodeSnapshot();
  return {
    ...result,
    repairScope: inferExecutionRepairScope(result, files)
  };
}

export async function validateGeneratedProjectExecution(onProgress?: RunProgressReporter): Promise<GeneratedExecutionValidationResult> {
  const startedAt = new Date().toISOString();
  const generatedCodeDir = getGeneratedCodeDir();
  const codeDir = createValidationWorkspacePath();
  const logDir = path.join(codeDir, '.validation-logs');

  if (!shouldValidateExecution()) {
    return buildResult({
      startedAt,
      workspace: generatedCodeDir,
      skipped: true,
      steps: [skippedStep('execution validation', 'VALIDATE_GENERATED_EXECUTION=false.')]
    });
  }

  await copyDirectoryForValidation(generatedCodeDir, codeDir);
  await fs.mkdir(logDir, { recursive: true });
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Validation workspace created at ${codeDir}.`
  });

  const steps: GeneratedValidationStep[] = [await copyEnvExampleIfSafe(codeDir)];
  const composeFile = await resolveComposeFile(codeDir);

  if (composeFile) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      message: `Compose file detected: ${composeFile}.`
    });
    steps.push(...(await validateWithDockerCompose(codeDir, composeFile, logDir, onProgress)));
    return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
  }

  steps.push(...(await validateLocalNode(codeDir, logDir, onProgress)));
  steps.push(...(await validateLocalPython(codeDir, logDir, onProgress)));

  return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
}
