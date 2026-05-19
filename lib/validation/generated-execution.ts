import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readGeneratedCodeSnapshot } from '@/lib/storage/file-writer';
import { inferExecutionRepairScope } from './repair-scope';
import type { GeneratedExecutionValidationResult, GeneratedValidationStep, RunProgressReporter } from '@/lib/types';

const COMMAND_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 45_000;
const LOG_TAIL_CHARS = 8_000;
const COMPOSE_PROJECT_NAME = 'agentic-sprint-builder-generated';
const COMMAND_HEARTBEAT_MS = 15_000;

interface CommandResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface ComposeEngine {
  name: 'docker compose' | 'nerdctl compose';
  command: string;
  baseArgs: string[];
  readinessArgs: string[];
}

const COMPOSE_ENGINES: ComposeEngine[] = [
  { name: 'docker compose', command: 'docker', baseArgs: ['compose'], readinessArgs: ['info'] },
  { name: 'nerdctl compose', command: 'nerdctl', baseArgs: ['compose'], readinessArgs: ['info'] }
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

function shouldCleanupGeneratedCompose() {
  return process.env.CLEAN_GENERATED_COMPOSE !== 'false';
}

function shouldRemoveGeneratedComposeImages() {
  return process.env.REMOVE_GENERATED_COMPOSE_IMAGES === 'true';
}

function shouldRunGeneratedTests() {
  return process.env.RUN_GENERATED_TESTS === 'true';
}

function shouldAutoStartRancherDesktop() {
  return process.env.AUTO_START_RANCHER_DESKTOP !== 'false';
}

function getRancherStartTimeoutMs() {
  const parsed = Number.parseInt(process.env.RANCHER_START_TIMEOUT_MS || '300000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

function getRancherPollMs() {
  const parsed = Number.parseInt(process.env.RANCHER_READY_POLL_MS || '3000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_000;
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

function isHostComposeInfrastructureFailure(message: string) {
  return /failed to connect to the backend|timed out dialing hyper-v socket|cannot connect to the docker daemon|docker daemon is not running|error during connect|containerd socket|no such file or directory.*docker|rancher desktop|wsl.*docker/i.test(
    message
  );
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths: string[]) {
  for (const candidate of paths) {
    if (candidate && (await pathExists(candidate))) return candidate;
  }

  return null;
}

async function getRancherDesktopLaunchCommand() {
  const configuredPath = process.env.RANCHER_DESKTOP_PATH?.trim();

  if (process.platform === 'win32') {
    const executable = await firstExistingPath([
      configuredPath || '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Rancher Desktop', 'Rancher Desktop.exe') : '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Rancher Desktop', 'Rancher Desktop.exe') : '',
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] || '', 'Rancher Desktop', 'Rancher Desktop.exe') : ''
    ]);

    return executable
      ? { command: executable, args: [] as string[], display: executable }
      : { command: 'rancher-desktop', args: [] as string[], display: 'rancher-desktop' };
  }

  if (process.platform === 'darwin') {
    return configuredPath
      ? { command: 'open', args: [configuredPath], display: `open ${configuredPath}` }
      : { command: 'open', args: ['-a', 'Rancher Desktop'], display: 'open -a Rancher Desktop' };
  }

  return configuredPath
    ? { command: configuredPath, args: [] as string[], display: configuredPath }
    : { command: 'rancher-desktop', args: [] as string[], display: 'rancher-desktop' };
}

function launchDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
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

function lastOutputLines(output: string, maxLines = 8) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n');
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout = COMMAND_TIMEOUT_MS,
  onHeartbeat?: (output: string, elapsedMs: number) => void | Promise<void>,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const child = spawn(command, args, { cwd, windowsHide: true });
    const startedAt = Date.now();

    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > LOG_TAIL_CHARS * 4) {
        output = output.slice(output.length - LOG_TAIL_CHARS * 4);
      }
    };

    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(heartbeatId);
      signal?.removeEventListener('abort', abortCommand);
      resolve({
        ok,
        output,
        error
      });
    };

    const abortCommand = () => {
      child.kill();
      finish(false, 'Run canceled by user.');
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish(false, `Command timed out after ${timeout}ms.`);
    }, timeout);

    const heartbeatId = setInterval(() => {
      void Promise.resolve(onHeartbeat?.(output, Date.now() - startedAt)).catch(() => {});
    }, COMMAND_HEARTBEAT_MS);

    if (signal?.aborted) {
      abortCommand();
      return;
    }
    signal?.addEventListener('abort', abortCommand, { once: true });

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    child.on('error', (error) => {
      finish(false, error.message);
    });

    child.on('close', (code, signal) => {
      finish(code === 0, signal ? `Command exited with signal ${signal}.` : code === 0 ? undefined : `Command failed with exit code ${code}.`);
    });
  });
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Run canceled by user.'));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);
    const abortDelay = () => {
      clearTimeout(timeoutId);
      reject(new Error('Run canceled by user.'));
    };

    signal?.addEventListener('abort', abortDelay, { once: true });
  });
}

async function probeComposeEngineReady(engine: ComposeEngine, cwd: string, signal?: AbortSignal) {
  const version = await runCommand(engine.command, [...engine.baseArgs, 'version'], cwd, 20_000, undefined, signal);
  if (!version.ok) {
    return {
      ok: false,
      engine,
      message: `${engine.name} CLI is not ready: ${version.error || 'command failed'}\n${truncate(maskSecrets(version.output), 1_200)}`
    };
  }

  const info = await runCommand(engine.command, engine.readinessArgs, cwd, 20_000, undefined, signal);
  if (!info.ok) {
    return {
      ok: false,
      engine,
      message: `${engine.name} engine is not ready: ${info.error || 'command failed'}\n${truncate(maskSecrets(info.output), 1_200)}`
    };
  }

  return {
    ok: true,
    engine,
    message: `${engine.name} CLI and engine are ready.`
  };
}

async function probeAnyComposeEngineReady(engines: ComposeEngine[], cwd: string, signal?: AbortSignal) {
  const failures: string[] = [];

  for (const engine of engines) {
    const probe = await probeComposeEngineReady(engine, cwd, signal);
    if (probe.ok) return probe;
    failures.push(probe.message);
  }

  return {
    ok: false,
    engine: engines[0],
    message: failures.join('\n\n')
  };
}

async function ensureComposeRuntimeReady(engines: ComposeEngine[], codeDir: string, onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: 'Checking Docker/Rancher engine readiness before Compose validation.'
  });

  const initialProbe = await probeAnyComposeEngineReady(engines, codeDir, signal);
  if (initialProbe.ok) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      level: 'success',
      message: initialProbe.message
    });

    return {
      name: 'Docker/Rancher readiness',
      status: 'PASS',
      command: `${initialProbe.engine.command} ${initialProbe.engine.readinessArgs.join(' ')}`,
      message: initialProbe.message
    };
  }

  if (!shouldAutoStartRancherDesktop()) {
    return skippedStep(
      'Docker/Rancher readiness',
      `AUTO_START_RANCHER_DESKTOP=false and Rancher/Docker is not ready. This is an environment/runtime issue, not a generated-code repair target.\n${initialProbe.message}`
    );
  }

  const launchCommand = await getRancherDesktopLaunchCommand();
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    level: 'warn',
    message: `Docker/Rancher is not ready. Launching Rancher Desktop: ${launchCommand.display}`
  });

  try {
    await launchDetached(launchCommand.command, launchCommand.args);
  } catch (error) {
    return skippedStep(
      'Docker/Rancher readiness',
      `Could not launch Rancher Desktop automatically. Rancher/Docker is not ready, so Compose validation was skipped as an environment/runtime issue. Set RANCHER_DESKTOP_PATH if Rancher Desktop is installed in a custom location.\n${error instanceof Error ? error.message : String(error)}\n\nInitial readiness failure:\n${initialProbe.message}`,
      launchCommand.display
    );
  }

  const timeoutMs = getRancherStartTimeoutMs();
  const pollMs = getRancherPollMs();
  const startedAt = Date.now();
  let lastProbe = initialProbe;
  let lastProgressAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Run canceled by user.');
    await abortableDelay(pollMs, signal);

    lastProbe = await probeAnyComposeEngineReady(engines, codeDir, signal);
    if (lastProbe.ok) {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'RUNNING',
        level: 'success',
        message: `Rancher/Docker became ready after ${elapsedSeconds}s.`
      });

      return {
        name: 'Docker/Rancher readiness',
        status: 'PASS',
        command: launchCommand.display,
        message: `Launched Rancher Desktop and waited until ${lastProbe.engine.name} was ready after ${elapsedSeconds}s.`
      };
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastProgressAt >= COMMAND_HEARTBEAT_MS) {
      lastProgressAt = elapsedMs;
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'RUNNING',
        message: `Waiting for Rancher/Docker to become ready after ${Math.round(elapsedMs / 1000)}s.\n${lastOutputLines(lastProbe.message, 4)}`
      });
    }
  }

  return skippedStep(
    'Docker/Rancher readiness',
    `Rancher Desktop was launched but Rancher/Docker is not ready after ${timeoutMs}ms. This is an environment/runtime issue, not a generated-code repair target. Increase RANCHER_START_TIMEOUT_MS if first startup takes longer.\n${lastProbe.message}`,
    launchCommand.display
  );
}

async function commandStep(params: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  logDir: string;
  timeout?: number;
  onProgress?: RunProgressReporter;
  signal?: AbortSignal;
}): Promise<GeneratedValidationStep> {
  const commandText = [params.command, ...params.args].join(' ');
  await params.onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Running: ${commandText}`
  });

  const result = await runCommand(params.command, params.args, params.cwd, params.timeout, async (output, elapsedMs) => {
    const tail = lastOutputLines(maskSecrets(output));
    await params.onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      message: tail ? `${params.name} still running after ${Math.round(elapsedMs / 1000)}s.\n${tail}` : `${params.name} still running after ${Math.round(elapsedMs / 1000)}s.`
    });
  }, params.signal);
  if (params.signal?.aborted) {
    throw new Error('Run canceled by user.');
  }
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
    message: result.ok ? 'Command completed successfully.' : `${result.error || 'Command failed.'}\n${truncate(maskSecrets(result.output), 6_000)}`
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

async function waitForHttp(name: string, urls: string[], timeoutMs = HEALTH_TIMEOUT_MS, onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  const startedAt = Date.now();
  let lastMessage = '';
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Checking ${name}: ${urls.join(' or ')}`
  });

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Run canceled by user.');
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store', signal });
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

async function collectComposeLogsForEngine(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string, signal?: AbortSignal) {
  const args = [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'];
  if (engine.name === 'docker compose') args.splice(args.length - 1, 0, '--no-color');
  const result = await runCommand(engine.command, args, codeDir, COMMAND_TIMEOUT_MS, undefined, signal);
  const logFile = await writeLog(logDir, `${engine.name.replace(/\s+/g, '-')}-logs`, result.output);
  return { logFile, output: maskSecrets(result.output) };
}

async function collectComposeDiagnosticsForEngine(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string, signal?: AbortSignal) {
  const logs = await collectComposeLogsForEngine(engine, codeDir, composeFile, logDir, signal);
  const sections = [`## Compose logs\n${logs.output}`];
  const ps = await runCommand(
    engine.command,
    ['ps', '-a', '--filter', `name=${COMPOSE_PROJECT_NAME}`, '--format', '{{.Names}}\t{{.Status}}'],
    codeDir,
    30_000,
    undefined,
    signal
  );

  if (ps.output.trim()) {
    sections.push(`## Container status\n${maskSecrets(ps.output)}`);
  }

  const containerNames = ps.output
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[0]?.trim())
    .filter(Boolean);

  const healthSections: string[] = [];
  for (const containerName of containerNames) {
    const inspect = await runCommand(engine.command, ['inspect', containerName, '--format', '{{json .State.Health}}'], codeDir, 30_000, undefined, signal);
    if (inspect.output.trim() && inspect.output.trim() !== 'null') {
      healthSections.push(`### ${containerName}\n${maskSecrets(inspect.output)}`);
    }
  }

  if (healthSections.length > 0) {
    sections.push(`## Healthcheck details\n${healthSections.join('\n')}`);
  }

  const output = sections.join('\n\n');
  const logFile = await writeLog(logDir, `${engine.name.replace(/\s+/g, '-')}-diagnostics`, output);
  return { logFile, output };
}

async function cleanupGeneratedComposeProject(
  engine: ComposeEngine,
  codeDir: string,
  composeFile: string,
  logDir: string,
  onProgress?: RunProgressReporter,
  signal?: AbortSignal
) {
  if (!shouldCleanupGeneratedCompose()) {
    return skippedStep(`${engine.name} cleanup generated project`, 'CLEAN_GENERATED_COMPOSE=false; existing generated Compose containers were left running.');
  }

  const args = [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'down', '--remove-orphans'];
  if (shouldRemoveGeneratedComposeImages()) {
    args.push('--rmi', 'local');
  }

  const step = await commandStep({
    name: `${engine.name} cleanup generated project`,
    command: engine.command,
    args,
    cwd: codeDir,
    logDir,
    timeout: 120_000,
    signal,
    onProgress
  });

  return {
    ...step,
    message:
      step.status === 'PASS'
        ? shouldRemoveGeneratedComposeImages()
          ? 'Removed previous generated Compose containers, networks, orphans, and local generated images for this project name.'
          : 'Removed previous generated Compose containers, networks, and orphans for this project name.'
        : step.message
  };
}

function getComposeEnginesToTry() {
  const preferred = getPreferredComposeEngine();
  if (preferred === 'auto') return COMPOSE_ENGINES;
  return COMPOSE_ENGINES.filter((engine) => engine.name === preferred);
}

async function validateWithDockerCompose(codeDir: string, composeFile: string, logDir: string, onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedValidationStep[]> {
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

  const readiness = await ensureComposeRuntimeReady(engines, codeDir, onProgress, signal);
  steps.push(readiness);
  if (readiness.status !== 'PASS') {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'SKIPPED',
      level: 'warn',
      message: 'Skipped Compose validation because Rancher/Docker is not ready.'
    });
    return steps;
  }

  for (const engine of engines) {
    const version = await commandStep({
      name: `${engine.name} version`,
      command: engine.command,
      args: [...engine.baseArgs, 'version'],
      cwd: codeDir,
      logDir,
      signal,
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
      signal,
      onProgress
    });
    steps.push(config);
    if (config.status === 'FAIL') {
      if (isHostComposeInfrastructureFailure(config.message)) {
        steps[steps.length - 1] = {
          ...config,
          status: 'SKIPPED',
          message: `Local Compose engine is not available, so generated project execution could not be validated on this machine. This is an environment/runtime issue, not a generated-code repair target.\n${config.message}`
        };
        await onProgress?.({
          stepId: 'execution-validation',
          stepStatus: 'SKIPPED',
          level: 'warn',
          message: `${engine.name} config could not run because the local Compose engine is unavailable; skipping execution repair.`
        });
      }

      return steps;
    }

    const cleanup = await cleanupGeneratedComposeProject(engine, codeDir, composeFile, logDir, onProgress, signal);
    steps.push(cleanup);
    if (cleanup.status === 'FAIL') {
      if (isHostComposeInfrastructureFailure(cleanup.message)) {
        steps[steps.length - 1] = {
          ...cleanup,
          status: 'SKIPPED',
          message: `Local Compose engine is unavailable or Rancher/Docker is not ready, so generated project cleanup could not run. This is an environment/runtime issue, not a generated-code repair target.\n${cleanup.message}`
        };
        await onProgress?.({
          stepId: 'execution-validation',
          stepStatus: 'SKIPPED',
          level: 'warn',
          message: `${engine.name} cleanup could not run because Rancher/Docker is unavailable.`
        });
      }

      return steps;
    }

    const buildArgs =
      engine.name === 'docker compose'
        ? [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'build', '--progress=plain']
        : [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'build'];
    const build = await commandStep({
      name: `${engine.name} build`,
      command: engine.command,
      args: buildArgs,
      cwd: codeDir,
      logDir,
      timeout: 300_000,
      signal,
      onProgress
    });
    steps.push(build);

    if (build.status === 'FAIL') {
      if (isHostComposeInfrastructureFailure(build.message)) {
        steps[steps.length - 1] = {
          ...build,
          status: 'SKIPPED',
          message: `Local Compose engine is unavailable or Rancher/Docker is not ready, so generated project execution could not continue. This is an environment/runtime issue, not a generated-code repair target.\n${build.message}`
        };
        await onProgress?.({
          stepId: 'execution-validation',
          stepStatus: 'SKIPPED',
          level: 'warn',
          message: `${engine.name} build could not continue because Rancher/Docker is unavailable; skipping generated-code repair for this environment failure.`
        });
        return steps;
      }

      return steps;
    }

    const up = await commandStep({
      name: `${engine.name} up`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'up', '-d'],
      cwd: codeDir,
      logDir,
      timeout: 180_000,
      signal,
      onProgress
    });
    steps.push(up);

    if (up.status === 'FAIL') {
      if (isHostComposeInfrastructureFailure(up.message)) {
        steps[steps.length - 1] = {
          ...up,
          status: 'SKIPPED',
          message: `Local Compose engine is unavailable or Rancher/Docker is not ready, so generated project execution could not continue. This is an environment/runtime issue, not a generated-code repair target.\n${up.message}`
        };
        await onProgress?.({
          stepId: 'execution-validation',
          stepStatus: 'SKIPPED',
          level: 'warn',
          message: `${engine.name} up could not continue because Rancher/Docker is unavailable; skipping generated-code repair for this environment failure.`
        });
        return steps;
      }

      const logs = await collectComposeDiagnosticsForEngine(engine, codeDir, composeFile, logDir, signal);
      steps.push({
        name: `${engine.name} diagnostics`,
        status: 'FAIL',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')} && ${engine.command} ps/inspect`,
        logFile: logs.logFile,
        message: `Captured ${engine.name} logs and container health diagnostics after startup failure.\n${truncate(logs.output, 2400)}`
      });
      return steps;
    }

    const backendHealth = await waitForHttp(
      'backend health',
      [`http://127.0.0.1:${getBackendPort()}/health`, `http://localhost:${getBackendPort()}/health`],
      HEALTH_TIMEOUT_MS,
      onProgress,
      signal
    );
    steps.push(backendHealth);

    const frontendHealth = await waitForHttp(
      'frontend health',
      [`http://127.0.0.1:${getFrontendPort()}/`, `http://localhost:${getFrontendPort()}/`],
      HEALTH_TIMEOUT_MS,
      onProgress,
      signal
    );
    steps.push(frontendHealth);

    if (backendHealth.status === 'FAIL' || frontendHealth.status === 'FAIL') {
      const logs = await collectComposeDiagnosticsForEngine(engine, codeDir, composeFile, logDir, signal);
      steps.push({
        name: `${engine.name} diagnostics`,
        status: 'FAIL',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')} && ${engine.command} ps/inspect`,
        logFile: logs.logFile,
        message: `Captured ${engine.name} logs and container health diagnostics after healthcheck failure.\n${truncate(logs.output, 2400)}`
      });
      return steps;
    }

    if (shouldRunGeneratedTests()) {
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
            signal,
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
            signal,
            onProgress
          })
        );
      } else {
        steps.push(skippedStep('frontend tests', 'No frontend test script was generated.'));
      }
    }

    return steps;
  }

  return steps;
}

async function validateLocalNode(codeDir: string, logDir: string, onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedValidationStep[]> {
  const frontendDir = await findNearestManifestDir(codeDir, ['package.json']);
  if (!frontendDir) return [skippedStep('frontend local validation', 'No generated frontend package manifest was found.')];
  const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(path.join(frontendDir, 'package.json'));
  if (!packageJson) return [skippedStep('frontend local validation', 'Generated frontend package manifest could not be parsed.')];

  const steps: GeneratedValidationStep[] = [];
  const npm = commandName('npm');
  steps.push(await commandStep({ name: 'frontend install', command: npm, args: ['install'], cwd: frontendDir, logDir, timeout: 300_000, signal, onProgress }));

  for (const script of ['build']) {
    if (packageJson.scripts?.[script]) {
      steps.push(await commandStep({ name: `frontend ${script}`, command: npm, args: ['run', script], cwd: frontendDir, logDir, signal, onProgress }));
    } else {
      steps.push(skippedStep(`frontend ${script}`, `Generated frontend package manifest has no ${script} script.`));
    }
  }

  return steps;
}

async function validateLocalPython(codeDir: string, logDir: string, onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedValidationStep[]> {
  const backendDir = await findNearestManifestDir(codeDir, ['requirements.txt', 'pyproject.toml']);
  if (!backendDir) return [skippedStep('backend local validation', 'No generated backend dependency manifest was found.')];
  const requirements = path.join(backendDir, 'requirements.txt');
  if (!(await pathExists(requirements))) return [skippedStep('backend local validation', 'Generated backend does not use requirements.txt; Python local validation currently supports requirements.txt only.')];

  const python = getPythonCommand();
  const venvDir = path.join(backendDir, '.venv');
  const venvPython = process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  const steps: GeneratedValidationStep[] = [];

  if (!(await pathExists(venvPython))) {
    steps.push(await commandStep({ name: 'backend venv', command: python, args: ['-m', 'venv', '.venv'], cwd: backendDir, logDir, signal, onProgress }));
    if (steps[steps.length - 1].status === 'FAIL') return steps;
  }

  steps.push(await commandStep({ name: 'backend install', command: venvPython, args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], cwd: backendDir, logDir, timeout: 300_000, signal, onProgress }));

  const testsExist = shouldRunGeneratedTests() && ((await pathExists(path.join(backendDir, 'tests'))) || (await pathExists(path.join(backendDir, 'app', 'tests'))));
  if (testsExist) {
    steps.push(await commandStep({ name: 'backend tests', command: venvPython, args: ['-m', 'pytest'], cwd: backendDir, logDir, signal, onProgress }));
  } else if (!shouldRunGeneratedTests()) {
    steps.push(skippedStep('backend tests', 'Formal generated tests are disabled for deploy-first validation. Set RUN_GENERATED_TESTS=true to enable them.'));
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
  const hasInfrastructureSkip = executionSteps.some((step) => step.status === 'SKIPPED' && /environment\/runtime issue|compose engine is unavailable|rancher\/docker is not ready/i.test(step.message));
  const findings = failedSteps.map((step) => `${step.name}: ${step.message}`);
  const status = params.skipped || allExecutionSkipped || hasInfrastructureSkip ? 'SKIPPED' : failedSteps.length > 0 ? 'NEEDS_FIX' : 'PASS';

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

export async function validateGeneratedProjectExecution(onProgress?: RunProgressReporter, signal?: AbortSignal): Promise<GeneratedExecutionValidationResult> {
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
    steps.push(...(await validateWithDockerCompose(codeDir, composeFile, logDir, onProgress, signal)));
    return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
  }

  steps.push(...(await validateLocalNode(codeDir, logDir, onProgress, signal)));
  steps.push(...(await validateLocalPython(codeDir, logDir, onProgress, signal)));

  return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
}
