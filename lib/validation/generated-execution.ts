import { spawn } from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { readGeneratedCodeSnapshot } from '@/lib/storage/file-writer';
import { inferExecutionRepairScope } from './repair-scope';
import type { GeneratedExecutionValidationResult, GeneratedValidationStep, PreparedMediaAsset, RunProgressReporter } from '@/lib/types';

const COMMAND_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 45_000;
const LOG_TAIL_CHARS = 8_000;
const COMPOSE_PROJECT_NAME = 'agentic-sprint-builder-generated';
const COMMAND_HEARTBEAT_MS = 15_000;
const DEFAULT_GENERATED_FRONTEND_HOST_PORT = 55_001;
const DEFAULT_GENERATED_BACKEND_HOST_PORT = 55_080;
const DEFAULT_GENERATED_DATABASE_HOST_PORT = 55_432;

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

type ImageFileFormat = 'gif' | 'jpeg' | 'png' | 'svg' | 'webp' | 'unknown';

const COMPOSE_ENGINES: ComposeEngine[] = [
  { name: 'docker compose', command: 'docker', baseArgs: ['compose'], readinessArgs: ['info'] },
  { name: 'nerdctl compose', command: 'nerdctl', baseArgs: ['compose'], readinessArgs: ['info'] }
];

const IMAGE_ASSET_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

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
  return Number(process.env.GENERATED_BACKEND_PORT || DEFAULT_GENERATED_BACKEND_HOST_PORT);
}

function getFrontendPort() {
  return Number(process.env.GENERATED_FRONTEND_PORT || DEFAULT_GENERATED_FRONTEND_HOST_PORT);
}

function shouldValidateExecution() {
  return process.env.VALIDATE_GENERATED_EXECUTION !== 'false';
}

function allowDockerValidation() {
  return process.env.ALLOW_GENERATED_DOCKER !== 'false';
}

function shouldFallbackToLocalValidationWhenComposeSkipped() {
  return process.env.FALLBACK_LOCAL_VALIDATION_WHEN_COMPOSE_SKIPPED !== 'false';
}

function shouldCleanupGeneratedCompose() {
  return process.env.CLEAN_GENERATED_COMPOSE !== 'false';
}

function shouldRemoveGeneratedComposeImages() {
  return process.env.REMOVE_GENERATED_COMPOSE_IMAGES === 'true';
}

function shouldRemoveGeneratedComposeVolumes() {
  return process.env.REMOVE_GENERATED_COMPOSE_VOLUMES !== 'false';
}

function shouldRunGeneratedTests() {
  return process.env.RUN_GENERATED_TESTS === 'true';
}

function shouldRunBrowserValidation() {
  return process.env.VALIDATE_GENERATED_BROWSER !== 'false';
}

function getBrowserValidationVirtualTimeBudgetMs() {
  const parsed = Number.parseInt(process.env.GENERATED_BROWSER_VIRTUAL_TIME_BUDGET_MS || '8000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8_000;
}

function getBrowserValidationAttempts() {
  const parsed = Number.parseInt(process.env.GENERATED_BROWSER_VALIDATION_ATTEMPTS || '2', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function shouldAutoStartRancherDesktop() {
  return process.env.AUTO_START_RANCHER_DESKTOP !== 'false';
}

function getRancherStartTimeoutMs() {
  const parsed = Number.parseInt(process.env.RANCHER_START_TIMEOUT_MS || '600000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}

function getRancherPollMs() {
  const parsed = Number.parseInt(process.env.RANCHER_READY_POLL_MS || '3000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_000;
}

function getRancherStartContainerEngine() {
  const raw = process.env.RANCHER_START_CONTAINER_ENGINE?.trim().toLowerCase();
  if (raw === 'docker' || raw === 'containerd' || raw === 'moby') return raw;
  return 'moby';
}

function getRancherStartKubernetesFlag() {
  const raw = process.env.RANCHER_START_KUBERNETES?.trim().toLowerCase();
  if (!raw) return [];
  if (['true', '1', 'yes', 'on'].includes(raw)) return ['--kubernetes.enabled=true'];
  if (['false', '0', 'no', 'off'].includes(raw)) return ['--kubernetes.enabled=false'];
  return [];
}

function getRancherBackgroundStartFlag() {
  const raw = process.env.RANCHER_START_IN_BACKGROUND?.trim().toLowerCase();
  if (raw && ['false', '0', 'no', 'off'].includes(raw)) return [];
  return ['--application.start-in-background'];
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

function truncateHead(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} trailing chars]`;
}

function extractDiagnosticHighlights(output: string, maxChars = 2_400) {
  const lines = output.split(/\r?\n/u);
  const highSignalPatterns = [
    /Ambiguous mapping|Cannot map .* method|There is already .* mapped/i,
    /Application run failed|Error starting ApplicationContext|BeanCreationException|IllegalStateException/i,
    /Failed to compile|Treating warnings as errors|Module not found|Cannot find module|npm ERR/i,
    /Traceback|ModuleNotFoundError|ImportError|SyntaxError|ReferenceError|TypeError/i,
    /\b(ERROR|FATAL)\b/i
  ];

  const selected: string[] = [];
  const seen = new Set<number>();
  for (const pattern of highSignalPatterns) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue;

      const start = Math.max(0, index - 1);
      const end = Math.min(lines.length - 1, index + 3);
      for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
        if (seen.has(contextIndex)) continue;
        seen.add(contextIndex);
        selected.push(lines[contextIndex]);
      }
    }
  }

  return selected.length > 0 ? truncateHead(selected.join('\n'), maxChars) : '';
}

function composeDiagnosticsMessage(engineName: string, phase: string, output: string) {
  const highlights = extractDiagnosticHighlights(output);
  if (!highlights) {
    return `Captured ${engineName} logs and container health diagnostics after ${phase}.\n${truncate(output, 2400)}`;
  }

  return [
    `Captured ${engineName} logs and container health diagnostics after ${phase}.`,
    'Key failure lines:',
    highlights,
    '',
    'Diagnostics tail:',
    truncate(output, 1400)
  ].join('\n');
}

function isHostComposeInfrastructureFailure(message: string) {
  if (isGeneratedCodeFailureSignal(message)) return false;

  return /failed to connect to the backend|timed out dialing hyper-v socket|cannot connect to the docker daemon|docker daemon is not running|error during connect|open \/\/\.\/pipe\/docker_engine|containerd socket|rancher desktop.*(?:not ready|unavailable)|docker compose engine is unavailable|local compose engine is unavailable|must be run with elevated privileges|wsl.*docker/i.test(
    message
  );
}

function isGeneratedCodeFailureSignal(message: string) {
  return /failed to compile|type error|typescript|tsc|next build|npm run build|module not found|can't resolve|copy failed|failed to calculate checksum|dockerfile|process .* did not complete successfully|frontend\/|backend\/|app\/|components\/|\.tsx?\b|\.jsx?\b|\.py\b|_next\/image|url parameter is not allowed/i.test(
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

function imageFormatFromExtension(filePath: string): Exclude<ImageFileFormat, 'unknown'> | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.png') return 'png';
  if (extension === '.webp') return 'webp';
  if (extension === '.gif') return 'gif';
  if (extension === '.svg') return 'svg';
  return null;
}

function imageFormatFromContentType(contentType: string | null): ImageFileFormat {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() || '';
  if (normalized === 'image/jpeg') return 'jpeg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  return 'unknown';
}

function sniffImageFormat(buffer: Buffer): ImageFileFormat {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/u.test(buffer.subarray(0, 6).toString('ascii'))) return 'gif';

  const textStart = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf-8').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/iu.test(textStart)) return 'svg';

  return 'unknown';
}

function imageFormatLabel(format: ImageFileFormat) {
  if (format === 'unknown') return 'unknown/non-image bytes';
  return format.toUpperCase();
}

function imageSignatureMismatchMessage(filePath: string, actual: ImageFileFormat) {
  const expected = imageFormatFromExtension(filePath);
  const relative = filePath.replace(/\\/g, '/');
  if (!expected) return null;
  if (actual === expected) return null;

  if (actual === 'svg' && expected !== 'svg') {
    return `${relative} has a ${path.extname(filePath)} extension but contains SVG text. Browsers will request it as ${expected.toUpperCase()} and fail to decode it; rename it to .svg and update references, or provide real ${expected.toUpperCase()} image bytes.`;
  }

  return `${relative} has a ${path.extname(filePath)} extension but its file signature is ${imageFormatLabel(actual)}; provide valid ${expected.toUpperCase()} bytes or change the extension and all references to match the actual format.`;
}

async function getRancherDesktopLaunchCommand() {
  const configuredPath = process.env.RANCHER_DESKTOP_PATH?.trim();

  if (process.platform === 'win32') {
    const configuredRdctlPath = process.env.RANCHER_RDCTL_PATH?.trim();
    const rdctl = await firstExistingPath([
      configuredRdctlPath || '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Rancher Desktop', 'resources', 'resources', 'win32', 'bin', 'rdctl.exe') : '',
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] || '', 'Rancher Desktop', 'resources', 'resources', 'win32', 'bin', 'rdctl.exe') : ''
    ]);

    if (rdctl) {
      const args = [
        'start',
        '--no-modal-dialogs',
        ...getRancherBackgroundStartFlag(),
        `--container-engine.name=${getRancherStartContainerEngine()}`,
        ...getRancherStartKubernetesFlag()
      ];
      return { command: rdctl, args, display: `${rdctl} ${args.join(' ')}` };
    }

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

export async function prewarmGeneratedComposeRuntime(onProgress?: RunProgressReporter, signal?: AbortSignal) {
  if (!shouldValidateExecution() || !allowDockerValidation() || !shouldAutoStartRancherDesktop()) return;

  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'PENDING',
    level: 'info',
    message: 'Prewarming Rancher/Docker in the background while AI agents run. First startup can take about 5 minutes.'
  });

  const probe = await probeAnyComposeEngineReady(getComposeEnginesToTry(), process.cwd(), signal);
  if (signal?.aborted) throw new Error('Run canceled by user.');

  if (probe.ok) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'PENDING',
      level: 'success',
      message: `Rancher/Docker already ready before deploy validation: ${probe.message}`
    });
    return;
  }

  const launchCommand = await getRancherDesktopLaunchCommand();
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'PENDING',
    level: 'warn',
    message: `Rancher/Docker is not ready yet. Starting Rancher early: ${launchCommand.display}. Estimated startup can take about 5 minutes.`
  });

  await launchDetached(launchCommand.command, launchCommand.args);

  const timeoutMs = getRancherStartTimeoutMs();
  const pollMs = getRancherPollMs();
  const startedAt = Date.now();
  let lastProbe = probe;
  let lastProgressAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Run canceled by user.');
    await abortableDelay(pollMs, signal);

    lastProbe = await probeAnyComposeEngineReady(getComposeEnginesToTry(), process.cwd(), signal);
    if (lastProbe.ok) {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'PENDING',
        level: 'success',
        message: `Rancher/Docker became ready during prewarm after ${elapsedSeconds}s: ${lastProbe.message}`
      });
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastProgressAt >= COMMAND_HEARTBEAT_MS) {
      lastProgressAt = elapsedMs;
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'PENDING',
        level: 'info',
        message: `Waiting for Rancher/Docker during prewarm after ${Math.round(elapsedMs / 1000)}s.\n${lastOutputLines(lastProbe.message, 4)}`
      });
    }
  }

  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'PENDING',
    level: 'warn',
    message: `Rancher/Docker prewarm timed out after ${timeoutMs}ms. Execution validation will check again later.\n${lastProbe.message}`
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

async function findImageAssetFiles(dir: string, ignored = new Set(['node_modules', '.next', '.git', '.venv', '.runtime-logs', '.validation-logs', '__pycache__', '.pytest_cache'])): Promise<string[]> {
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
      matches.push(...(await findImageAssetFiles(fullPath, ignored)));
    } else if (entry.isFile() && IMAGE_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      matches.push(fullPath);
    }
  }

  return matches;
}

async function generatedProjectTextSearchBlob(dir: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const chunks: string[] = [];
  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry.name)) continue;

    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await generatedProjectTextSearchBlob(entryPath));
      continue;
    }

    if (!entry.isFile() || !shouldScanGeneratedTextFile(entryPath)) continue;
    try {
      const stat = await fs.stat(entryPath);
      if (stat.size > 1_000_000) continue;
      chunks.push((await fs.readFile(entryPath, 'utf-8')).toLowerCase());
    } catch {
      // Ignore unreadable generated files; runtime validation will catch concrete failures.
    }
  }

  return chunks.join('\n');
}

function imageAssetIsReferenced(codeDir: string, filePath: string, sourceText: string) {
  const relativePath = path.relative(codeDir, filePath).replace(/\\/g, '/').toLowerCase();
  const publicIndex = relativePath.indexOf('/public/');
  const springStaticIndex = relativePath.indexOf('/src/main/resources/static/');
  const publicRelative = publicIndex >= 0 ? relativePath.slice(publicIndex + '/public/'.length) : relativePath;
  const springStaticRelative =
    springStaticIndex >= 0 ? relativePath.slice(springStaticIndex + '/src/main/resources/static/'.length) : '';
  const aliases = [
    relativePath,
    publicRelative,
    `/${publicRelative}`,
    publicRelative.replace(/^assets\//u, '/assets/'),
    publicRelative.replace(/^images\//u, '/images/'),
    springStaticRelative,
    springStaticRelative ? `/${springStaticRelative}` : ''
  ];

  return aliases.some((alias) => alias && sourceText.includes(alias));
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

function quoteWindowsShellArg(value: string) {
  if (!value) return '""';
  if (!/[\s&()<>^|"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveSpawnCommand(command: string, args: string[]) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', [command, ...args].map(quoteWindowsShellArg).join(' ')]
    };
  }

  return { command, args };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout = COMMAND_TIMEOUT_MS,
  onHeartbeat?: (output: string, elapsedMs: number) => void | Promise<void>,
  signal?: AbortSignal,
  maxOutputChars = LOG_TAIL_CHARS * 4
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const spawnCommand = resolveSpawnCommand(command, args);
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(spawnCommand.command, spawnCommand.args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({
        ok: false,
        output,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const startedAt = Date.now();

    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > maxOutputChars) {
        output = output.slice(output.length - maxOutputChars);
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
      message: `Rancher/Docker ready: ${initialProbe.message}`
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

async function validateStaticImageAssetIntegrity(codeDir: string, logDir: string): Promise<GeneratedValidationStep> {
  const imageFiles = await findImageAssetFiles(codeDir);
  if (imageFiles.length === 0) {
    return skippedStep('static image asset integrity', 'No generated static image assets were found.');
  }

  const sourceText = await generatedProjectTextSearchBlob(codeDir);
  const referencedImageFiles = imageFiles.filter((filePath) => imageAssetIsReferenced(codeDir, filePath, sourceText));
  if (referencedImageFiles.length === 0) {
    return skippedStep('static image asset integrity', `Found ${imageFiles.length} generated image asset(s), but none were referenced by generated source files.`);
  }

  const findings: string[] = [];
  for (const filePath of referencedImageFiles) {
    const relativePath = path.relative(codeDir, filePath).replace(/\\/g, '/');
    const buffer = await fs.readFile(filePath);
    const actual = sniffImageFormat(buffer);
    const finding = imageSignatureMismatchMessage(relativePath, actual);
    if (finding) findings.push(finding);
  }

  if (findings.length === 0) {
    return {
      name: 'static image asset integrity',
      status: 'PASS',
      command: `scan ${referencedImageFiles.length} referenced generated image asset(s)`,
      message: `All ${referencedImageFiles.length} referenced generated image asset(s) have content signatures that match their extensions.`
    };
  }

  const logFile = await writeLog(
    logDir,
    'static-image-asset-integrity',
    [
      'Generated static image assets with invalid signatures:',
      ...findings.map((finding) => `- ${finding}`),
      '',
      'Repair guidance:',
      '- Do not write SVG/XML text into .jpg, .jpeg, .png, .webp, or .gif files.',
      '- Either rename SVG assets to .svg and update every frontend/backend seed reference, or provide real raster image bytes through prepared media assets.',
      '- Plain <img> and CSS background URLs must point to files the browser can decode.'
    ].join('\n')
  );

  return {
    name: 'static image asset integrity',
    status: 'FAIL',
    command: `scan ${referencedImageFiles.length} referenced generated image asset(s)`,
    logFile,
    message: `Generated static image assets have invalid file signatures:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
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

function frontendBaseUrls() {
  return [`http://127.0.0.1:${getFrontendPort()}/`, `http://localhost:${getFrontendPort()}/`];
}

const PREPARED_MEDIA_MANIFEST_RELATIVE_PATH = path.join('frontend', 'public', 'assets', 'generated-media', 'media-manifest.json');

function backendBaseUrls() {
  return [`http://127.0.0.1:${getBackendPort()}/`, `http://localhost:${getBackendPort()}/`];
}

function backendHealthUrls() {
  return backendBaseUrls().flatMap((baseUrl) => [urlWithPath(baseUrl, '/health'), urlWithPath(baseUrl, '/api/health')]);
}

function urlWithPath(baseUrl: string, route: string) {
  return new URL(route.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function safeArtifactName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'artifact';
}

async function fetchFirstOk(urls: string[], signal?: AbortSignal) {
  let lastMessage = '';

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal });
      const body = await response.text();
      if (response.ok) {
        return { ok: true as const, url, status: response.status, body };
      }
      lastMessage = `${url} returned ${response.status}: ${truncate(body, 800)}`;
    } catch (error) {
      lastMessage = `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return { ok: false as const, url: urls[0] || '', status: 0, body: '', message: lastMessage || 'No URL returned a successful response.' };
}

async function hasGeneratedProductContract(codeDir: string) {
  return (
    (await pathExists(path.join(codeDir, 'frontend', 'app', 'products'))) ||
    (await generatedProjectMentions(codeDir, /\/api\/products|api\/products|\/products\/\{|\bproducts\/\[id\]/i))
  );
}

async function requiresRealProductMedia(codeDir: string) {
  if (!(await hasGeneratedProductContract(codeDir))) return false;
  const text = await generatedProjectTextSearchBlob(codeDir);
  return /main[_-]?image|thumbnail|productimage|product-image|imagegallery|image gallery|hero(?:section)?|watch|wristwatch|timepiece|chronograph/i.test(text);
}

type PreparedMediaManifest = {
  assets?: Partial<PreparedMediaAsset>[];
};

function isPreparedMediaAsset(value: Partial<PreparedMediaAsset>): value is PreparedMediaAsset {
  return Boolean(value.title && value.path && value.publicUrl && value.sourceImageUrl && value.mimeType && typeof value.sizeBytes === 'number');
}

async function readPreparedMediaAssetsManifest(codeDir: string) {
  const manifest = await readJsonFile<PreparedMediaManifest>(path.join(codeDir, PREPARED_MEDIA_MANIFEST_RELATIVE_PATH));
  return (manifest?.assets ?? []).filter(isPreparedMediaAsset);
}

function preparedMediaAssetReferences(assets: PreparedMediaAsset[]) {
  return Array.from(
    new Set(
      assets.flatMap((asset) => [
        asset.publicUrl,
        encodeURI(asset.publicUrl),
        asset.path.replace(/^frontend\/public/u, '').replace(/\\/g, '/')
      ])
    )
  ).filter(Boolean);
}

function containsAnyTextReference(output: string, references: string[]) {
  const haystack = output.toLowerCase();
  return references.some((reference) => haystack.includes(reference.toLowerCase()));
}

function isGenericPlaceholderImageReference(value: string) {
  return /picsum\.photos|placehold\.co|via\.placeholder|placeholder\.com|dummyimage|loremflickr|source\.unsplash\.com\/random/i.test(value);
}

function isPreparedGeneratedMediaPath(filePath: string) {
  return filePath.replace(/\\/g, '/').toLowerCase().includes('/assets/generated-media/');
}

async function referencedGeneratedImageAssetSummary(codeDir: string, options?: { excludePreparedMedia?: boolean }) {
  const imageFiles = await findImageAssetFiles(codeDir);
  if (imageFiles.length === 0) {
    return { referenced: [] as string[], invalid: [] as string[] };
  }

  const sourceText = await generatedProjectTextSearchBlob(codeDir);
  const referencedImageFiles = imageFiles.filter((filePath) => {
    if (options?.excludePreparedMedia && isPreparedGeneratedMediaPath(filePath)) return false;
    return imageAssetIsReferenced(codeDir, filePath, sourceText);
  });
  const invalid: string[] = [];

  for (const filePath of referencedImageFiles) {
    const relativePath = path.relative(codeDir, filePath).replace(/\\/g, '/');
    const buffer = await fs.readFile(filePath);
    const actual = sniffImageFormat(buffer);
    const finding = imageSignatureMismatchMessage(relativePath, actual);
    if (finding) invalid.push(finding);
  }

  return {
    referenced: referencedImageFiles.map((filePath) => path.relative(codeDir, filePath).replace(/\\/g, '/')),
    invalid
  };
}

function configuredBrowserExecutableCandidates() {
  return [
    process.env.GENERATED_BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.BROWSER,
    process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' && process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
    process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'msedge'
  ].filter((value): value is string => Boolean(value?.trim()));
}

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

async function findHeadlessBrowserExecutable() {
  for (const candidate of configuredBrowserExecutableCandidates()) {
    if (looksLikeFilePath(candidate)) {
      if (await pathExists(candidate)) return candidate;
      continue;
    }

    const probe = await runCommand(candidate, ['--version'], process.cwd(), 10_000, undefined, undefined, 2_000);
    if (probe.ok) return candidate;
  }

  return null;
}

function extractVisibleTextFromHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDomEvidence(output: string) {
  const marker = 'DOM evidence:\n';
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return null;

  try {
    return JSON.parse(output.slice(markerIndex + marker.length)) as {
      text?: string;
      html?: string;
      productLinks?: string[];
      images?: Array<{ src?: string; alt?: string; complete?: boolean; naturalWidth?: number; naturalHeight?: number }>;
      brokenImages?: Array<{ src?: string; alt?: string; complete?: boolean; naturalWidth?: number; naturalHeight?: number }>;
      imageCount?: number;
      productNavigation?: { attempted?: boolean; before?: string; after?: string; navigated?: boolean; hasDetailSignal?: boolean; reason?: string };
      galleryInteraction?: { attempted?: boolean; changed?: boolean; mainBefore?: string; mainAfter?: string; imageCount?: number; reason?: string };
    };
  } catch {
    return null;
  }
}

function hasUsableRenderedMedia(domEvidence: ReturnType<typeof extractDomEvidence>) {
  const renderedImages = domEvidence?.images ?? [];
  const decodedImages = renderedImages.filter(
    (image) => image.src && (image.naturalWidth ?? 0) > 0 && (image.naturalHeight ?? 0) > 0 && !isGenericPlaceholderImageReference(image.src)
  );

  return (decodedImages.length > 0 || (domEvidence?.imageCount ?? 0) > 0) && (domEvidence?.brokenImages?.length ?? 0) === 0;
}

function browserRuntimeFindings(
  output: string,
  options?: { expectProductList?: boolean; expectProductDetail?: boolean; preparedAssetReferences?: string[] }
) {
  const domEvidence = extractDomEvidence(output);
  const visibleText = domEvidence?.text || output;
  const domSearchText = [domEvidence?.text, domEvidence?.html, JSON.stringify(domEvidence?.brokenImages ?? []), JSON.stringify(domEvidence?.images ?? []), output].filter(Boolean).join('\n');
  const findings = [...frontendRuntimeFindings(visibleText)];
  const brokenImages = domEvidence?.brokenImages?.filter((image) => image.src) ?? [];
  const checks = [
    { pattern: /blocked by CORS policy|no ['"]access-control-allow-origin['"] header|access to fetch at .* from origin/i, message: 'browser reported a CORS-blocked frontend API request' },
    { pattern: /TypeError:\s*Failed to fetch|Failed to fetch|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED/i, message: 'browser reported a failed frontend network request' },
    { pattern: /Uncaught \(in promise\)|RuntimeError|ReferenceError/i, message: 'browser console reported a runtime JavaScript error' }
  ];

  for (const check of checks) {
    if (check.pattern.test(output)) findings.push(check.message);
  }

  if (brokenImages.length > 0) {
    const examples = brokenImages
      .slice(0, 5)
      .map((image) => `${image.alt || 'image'} (${image.src})`)
      .join(', ');
    findings.push(
      `browser rendered ${brokenImages.length} broken image(s) with naturalWidth=0: ${examples}. Fix missing/corrupt frontend public image assets, URL paths, or MIME/extension mismatches.`
    );
  }

  if (options?.expectProductList) {
    if (isGenericPlaceholderImageReference(domSearchText)) {
      findings.push('browser DOM uses generic placeholder image services instead of product-relevant/mockup-relevant imagery');
    }

    const hasProductDetailLink = Boolean(domEvidence?.productLinks?.length) || /href=["'][^"']*\/products\/[^"']+["']/i.test(domSearchText);
    const hasProductCommerceSignal = /\$[0-9][0-9,.]*|view details|add to cart|product card|price/i.test(visibleText);
    if (!hasProductDetailLink && !hasProductCommerceSignal) {
      findings.push('browser DOM did not show product cards, product prices, or product-detail navigation after hydration');
    }

    if ((domEvidence?.imageCount ?? 0) === 0 && /product|price|\$[0-9]|watch|timepiece|collection/i.test(visibleText)) {
      findings.push('browser DOM renders product/list content without any real image elements; product imagery must use prepared local media assets or relevant licensed images, not empty CSS placeholders');
    }

    if (domEvidence?.productNavigation) {
      if (!domEvidence.productNavigation.attempted) {
        findings.push(`browser could not find a clickable product card for list-to-detail navigation: ${domEvidence.productNavigation.reason || 'no reason recorded'}`);
      } else if (!domEvidence.productNavigation.navigated || !domEvidence.productNavigation.hasDetailSignal) {
        findings.push(
          `clicking a product card did not navigate to a usable product detail page; before=${domEvidence.productNavigation.before || ''}, after=${domEvidence.productNavigation.after || ''}`
        );
      }
    }
  }

  if (options?.expectProductDetail) {
    if (isGenericPlaceholderImageReference(domSearchText)) {
      findings.push('browser DOM uses generic placeholder image services instead of product-relevant/mockup-relevant imagery');
    }

    const hasDetailSignal = /\$[0-9][0-9,.]*|add to cart|specifications?|description|movement|calibre|details/i.test(visibleText);
    if (!hasDetailSignal) {
      findings.push('browser DOM did not show product detail content after hydration');
    }

    if ((domEvidence?.imageCount ?? 0) === 0 && /product|price|\$[0-9]|watch|timepiece|chronograph|specifications?/i.test(visibleText)) {
      findings.push('browser DOM renders product detail content without any real image elements; product galleries must use prepared local media assets or relevant licensed images, not empty CSS placeholders');
    }

    if ((domEvidence?.imageCount ?? 0) > 0 && (domEvidence?.imageCount ?? 0) < 2 && /product|price|\$[0-9]|watch|timepiece|chronograph|specifications?/i.test(visibleText)) {
      findings.push('browser DOM did not show a product detail gallery with both a main image and thumbnail images');
    }

    if (domEvidence?.galleryInteraction) {
      if (!domEvidence.galleryInteraction.attempted) {
        findings.push(`browser could not find a non-duplicate thumbnail image to exercise gallery interaction: ${domEvidence.galleryInteraction.reason || 'no reason recorded'}`);
      } else if (!domEvidence.galleryInteraction.changed) {
        findings.push(
          `clicking a thumbnail did not update the main product image; before=${domEvidence.galleryInteraction.mainBefore || ''}, after=${domEvidence.galleryInteraction.mainAfter || ''}`
        );
      }
    }
  }

  if ((options?.expectProductList || options?.expectProductDetail) && options.preparedAssetReferences?.length) {
    if (!containsAnyTextReference(domSearchText, options.preparedAssetReferences) && !hasUsableRenderedMedia(domEvidence)) {
      findings.push('browser DOM does not use prepared local media assets from /assets/generated-media');
    }
  }

  return Array.from(new Set(findings));
}

function getFreeTcpPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function fetchJsonWithRetry<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('Run canceled by user.');
    try {
      const response = await fetch(url, { cache: 'no-store', signal });
      if (response.ok) return (await response.json()) as T;
      lastError = `${url} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await abortableDelay(250, signal);
  }

  throw new Error(lastError || `Timed out waiting for ${url}.`);
}

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type CdpEvent = {
  method: string;
  params?: unknown;
};

class CdpSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private events: CdpEvent[] = [];

  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string) {
    return new Promise<CdpSession>((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('Global WebSocket is not available in this Node runtime.'));
        return;
      }

      const ws = new WebSocket(url);
      const session = new CdpSession(ws);

      ws.addEventListener('open', () => resolve(session), { once: true });
      ws.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools Protocol.')), { once: true });
      ws.addEventListener('message', (event) => session.handleMessage(event));
      ws.addEventListener('close', () => session.rejectPending(new Error('Chrome DevTools Protocol connection closed.')));
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  getEvents() {
    return this.events.slice();
  }

  close() {
    this.ws.close();
  }

  private handleMessage(event: MessageEvent) {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools command failed.'));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.events.push({ method: message.method, params: message.params });
    }
  }

  private rejectPending(error: Error) {
    for (const pending of Array.from(this.pending.values())) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function formatCdpEvents(events: CdpEvent[]) {
  const lines: string[] = [];

  for (const event of events) {
    const params = event.params as Record<string, unknown> | undefined;
    if (event.method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params?.args)
        ? (params?.args as Array<Record<string, unknown>>).map((arg) => String(arg.value ?? arg.description ?? '')).filter(Boolean).join(' ')
        : '';
      if (args) lines.push(`console: ${args}`);
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails as Record<string, unknown> | undefined;
      lines.push(`exception: ${String(details?.text || details?.exception || 'runtime exception')}`);
    } else if (event.method === 'Log.entryAdded') {
      const entry = params?.entry as Record<string, unknown> | undefined;
      lines.push(`log: ${String(entry?.level || '')} ${String(entry?.text || '')}`);
    } else if (event.method === 'Network.loadingFailed') {
      lines.push(`network failed: ${String(params?.errorText || '')} ${String(params?.blockedReason || '')} ${String(params?.type || '')}`);
    } else if (event.method === 'Network.responseReceived') {
      const response = params?.response as Record<string, unknown> | undefined;
      const status = Number(response?.status || 0);
      const url = String(response?.url || '');
      if (status >= 400 && (/\/api\/|_next\/image|\/products?/i.test(url))) {
        lines.push(`network ${status}: ${url}`);
      }
    }
  }

  return lines.join('\n');
}

async function waitForChromeTarget(port: number, signal?: AbortSignal) {
  type ChromeTarget = { type?: string; webSocketDebuggerUrl?: string; url?: string };
  const targets = await fetchJsonWithRetry<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`, 15_000, signal);
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) || targets.find((target) => target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome DevTools target did not expose a websocket debugger URL.');
  return page.webSocketDebuggerUrl;
}

async function collectBrowserPageEvidence(params: {
  browser: string;
  url: string;
  codeDir: string;
  logDir: string;
  artifactName: string;
  expectProductList?: boolean;
  expectProductDetail?: boolean;
  signal?: AbortSignal;
}) {
  const port = await getFreeTcpPort();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `${params.artifactName}-profile-`));
  const screenshotFile = path.join(params.logDir, `${params.artifactName}.png`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1200,1600',
    'about:blank'
  ];
  const child = spawn(params.browser, args, { cwd: params.codeDir, windowsHide: true });
  let processOutput = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    processOutput += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    processOutput += chunk.toString();
  });

  let session: CdpSession | null = null;
  try {
    const websocketUrl = await waitForChromeTarget(port, params.signal);
    session = await CdpSession.connect(websocketUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Log.enable');
    await session.send('Page.navigate', { url: params.url });
    await abortableDelay(getBrowserValidationVirtualTimeBudgetMs(), params.signal);

    const evaluation = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body ? document.body.innerText : '';
        const html = document.documentElement ? document.documentElement.outerHTML : '';
        const productLinks = Array.from(document.querySelectorAll('a[href*="/products/"]')).map((node) => node.href);
        const images = Array.from(document.images).map((image) => ({
          src: image.currentSrc || image.src,
          alt: image.alt,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        }));
        return {
          url: location.href,
          title: document.title,
          text,
          bodyLength: text.length,
          productLinks,
          images: images.slice(0, 20),
          brokenImages: images.filter((image) => !image.complete || image.naturalWidth === 0).slice(0, 10),
          imageCount: images.length,
          html: html.slice(0, 120000)
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    const screenshot = await session.send<{ data?: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (screenshot.data) await fs.writeFile(screenshotFile, screenshot.data, 'base64');
    const domEvidence = (evaluation.result?.value ?? {}) as Record<string, unknown>;

    if (params.expectProductList) {
      const navigation = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(async () => {
          const before = location.href;
          const candidates = Array.from(document.querySelectorAll('a[href*="/products/"], button, [role="button"], article, div'));
          const productCard = candidates.find((node) => {
            const text = (node.innerText || '').replace(/\\s+/g, ' ');
            const cursor = getComputedStyle(node).cursor;
            const href = node.href || node.getAttribute?.('href') || '';
            return /\\/products\\//.test(href) || (cursor === 'pointer' && /\\$[0-9][0-9,.]*/.test(text) && /[A-Za-z]/.test(text));
          });
          if (!productCard) return { attempted: false, before, reason: 'no clickable product card or product detail link found' };
          productCard.click();
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const text = document.body ? document.body.innerText : '';
          const images = Array.from(document.images);
          return {
            attempted: true,
            before,
            after: location.href,
            navigated: /\\/products\\/[^/]+/.test(location.pathname),
            hasDetailSignal: /\\$[0-9][0-9,.]*|add to cart|specifications?|movement|calibre|description/i.test(text),
            imageCount: images.length,
            brokenImageCount: images.filter((image) => !image.complete || image.naturalWidth === 0).length
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
      domEvidence.productNavigation = navigation.result?.value ?? { attempted: false, reason: 'product navigation probe did not return evidence' };
    }

    if (params.expectProductDetail) {
      const gallery = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(async () => {
          const images = Array.from(document.images);
          const mainBefore = images[0]?.currentSrc || images[0]?.src || '';
          const thumbnail = images.find((image, index) => index > 0 && (image.currentSrc || image.src) && (image.currentSrc || image.src) !== mainBefore);
          if (!thumbnail) {
            return {
              attempted: false,
              imageCount: images.length,
              mainBefore,
              reason: images.length <= 1 ? 'fewer than two rendered product images' : 'all thumbnails duplicate the main image'
            };
          }
          thumbnail.click();
          await new Promise((resolve) => setTimeout(resolve, 800));
          const mainAfter = document.images[0]?.currentSrc || document.images[0]?.src || '';
          return {
            attempted: true,
            imageCount: document.images.length,
            mainBefore,
            mainAfter,
            changed: mainBefore !== mainAfter
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
      domEvidence.galleryInteraction = gallery.result?.value ?? { attempted: false, reason: 'gallery interaction probe did not return evidence' };
    }

    return {
      command: `${params.browser} ${args.join(' ')}`,
      screenshotFile,
      output: [
        `URL: ${params.url}`,
        `Screenshot: ${screenshotFile}`,
        `Browser process output:\n${processOutput}`,
        `CDP events:\n${formatCdpEvents(session.getEvents())}`,
        `DOM evidence:\n${JSON.stringify(domEvidence, null, 2)}`
      ].join('\n\n')
    };
  } finally {
    session?.close();
    child.kill();
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateBrowserRenderedPage(params: {
  name: string;
  url: string;
  codeDir: string;
  logDir: string;
  signal?: AbortSignal;
  expectProductList?: boolean;
  expectProductDetail?: boolean;
  preparedAssetReferences?: string[];
}): Promise<GeneratedValidationStep> {
  if (!shouldRunBrowserValidation()) {
    return skippedStep(params.name, 'VALIDATE_GENERATED_BROWSER=false; browser hydration validation was skipped.');
  }

  const browser = await findHeadlessBrowserExecutable();
  if (!browser) {
    return skippedStep(
      params.name,
      'No Chrome/Chromium/Edge executable was found, so browser hydration validation was skipped. Set GENERATED_BROWSER_EXECUTABLE_PATH to enable this check.'
    );
  }

  await fs.mkdir(params.logDir, { recursive: true });
  const artifactName = safeArtifactName(params.name);
  const attempts = getBrowserValidationAttempts();
  const browserErrors: string[] = [];
  let evidence: { command: string; screenshotFile: string; output: string } | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      evidence = await collectBrowserPageEvidence({
        browser,
        url: params.url,
        codeDir: params.codeDir,
        logDir: params.logDir,
        artifactName: attempt === 1 ? artifactName : `${artifactName}-attempt-${attempt}`,
        expectProductList: params.expectProductList,
        expectProductDetail: params.expectProductDetail,
        signal: params.signal
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      browserErrors.push(`Attempt ${attempt}/${attempts}: ${message}`);
      await writeLog(params.logDir, `${artifactName}-browser-error-attempt-${attempt}`, message);
      if (params.signal?.aborted) break;
      if (attempt < attempts) await abortableDelay(1_000, params.signal);
    }
  }

  if (!evidence) {
    const logFile = await writeLog(params.logDir, `${artifactName}-browser-error`, browserErrors.join('\n') || 'Browser validation failed without an error message.');
    return {
      name: params.name,
      status: 'FAIL',
      command: `${browser} --headless=new --remote-debugging-port=<dynamic> ${params.url}`,
      logFile,
      message: `Headless browser validation failed for ${params.url} after ${attempts} attempt(s). ${browserErrors.join(' | ')}`
    };
  }

  const logFile = await writeLog(params.logDir, `${artifactName}-browser-evidence`, evidence.output);

  const findings = browserRuntimeFindings(evidence.output, {
    expectProductList: params.expectProductList,
    expectProductDetail: params.expectProductDetail,
    preparedAssetReferences: params.preparedAssetReferences
  });

  return findings.length > 0
    ? {
        name: params.name,
        status: 'FAIL',
        command: evidence.command,
        logFile,
        message: `Browser-rendered page failed after hydration at ${params.url}. Screenshot: ${evidence.screenshotFile}. Findings: ${findings.join('; ')}.`
      }
    : {
        name: params.name,
        status: 'PASS',
        command: evidence.command,
        logFile,
        message: `Browser-rendered page passed after hydration at ${params.url}. Screenshot: ${evidence.screenshotFile}.`
      };
}

const GENERATED_SCAN_EXTENSIONS = new Set([
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
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

function shouldScanGeneratedTextFile(filePath: string) {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'dockerfile' || name === 'containerfile' || name === '.env.example') return true;
  return GENERATED_SCAN_EXTENSIONS.has(path.extname(name));
}

function shouldScanPreparedMediaUsageFile(filePath: string) {
  const relativePath = filePath.replace(/\\/g, '/').toLowerCase();
  if (relativePath.endsWith('/assets/generated-media/media-manifest.json')) return false;

  return ['.css', '.html', '.js', '.json', '.jsx', '.mjs', '.py', '.ts', '.tsx'].includes(path.extname(filePath).toLowerCase());
}

async function generatedProjectContainsAnyPreparedMediaReference(dir: string, references: string[]): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry.name)) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await generatedProjectContainsAnyPreparedMediaReference(entryPath, references)) return true;
    } else if (entry.isFile() && shouldScanPreparedMediaUsageFile(entryPath)) {
      try {
        const stat = await fs.stat(entryPath);
        if (stat.size > 1_000_000) continue;
        if (containsAnyTextReference(await fs.readFile(entryPath, 'utf-8'), references)) return true;
      } catch {
        // Ignore unreadable generated files and continue scanning the rest.
      }
    }
  }

  return false;
}

async function validatePreparedMediaAssetUsage(codeDir: string, preparedAssets: PreparedMediaAsset[]): Promise<GeneratedValidationStep> {
  if (preparedAssets.length === 0) {
    if (await requiresRealProductMedia(codeDir)) {
      return {
        name: 'frontend prepared media usage smoke',
        status: 'FAIL',
        command: 'scan generated project for product media requirements and prepared /assets/generated-media manifest',
        message:
          'Generated product UI requires real product/hero/detail imagery, but no prepared local media asset manifest was found. Improve media acquisition or use relevant licensed image URLs; do not pass with empty CSS/image placeholders.'
      };
    }

    return skippedStep('frontend prepared media usage smoke', 'No prepared local media asset manifest was found and no product media requirement was detected.');
  }

  const references = preparedMediaAssetReferences(preparedAssets);
  const used = references.length > 0 && (await generatedProjectContainsAnyPreparedMediaReference(codeDir, references));

  if (used) {
    return {
      name: 'frontend prepared media usage smoke',
      status: 'PASS',
      command: `scan generated project source for ${preparedAssets.length} prepared /assets/generated-media reference(s)`,
      message: `Generated project source references prepared local media assets: ${preparedAssets.map((asset) => asset.publicUrl).join(', ')}`
    };
  }

  const localMedia = await referencedGeneratedImageAssetSummary(codeDir, { excludePreparedMedia: true });
  if (localMedia.referenced.length > 0 && localMedia.invalid.length === 0) {
    return {
      name: 'frontend prepared media usage smoke',
      status: 'PASS',
      command: `scan generated project source for prepared /assets/generated-media references or valid alternate local image assets`,
      message: `Generated project does not reference /assets/generated-media, but it uses ${localMedia.referenced.length} valid referenced local image asset(s): ${localMedia.referenced
        .slice(0, 6)
        .join(', ')}`
    };
  }

  return {
    name: 'frontend prepared media usage smoke',
    status: 'FAIL',
    command: `scan generated project source for ${preparedAssets.length} prepared /assets/generated-media reference(s)`,
    message:
      'Prepared local media assets were downloaded for the run, but generated project source does not reference any /assets/generated-media URL or other valid referenced local image assets. Use the provided local publicUrl values in frontend code or backend seed data instead of placeholders or unrelated remote images.'
  };
}

async function generatedProjectMentions(dir: string, pattern: RegExp): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry.name)) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await generatedProjectMentions(entryPath, pattern)) return true;
    } else if (entry.isFile() && shouldScanGeneratedTextFile(entryPath)) {
      try {
        const stat = await fs.stat(entryPath);
        if (stat.size > 1_000_000) continue;
        if (pattern.test(await fs.readFile(entryPath, 'utf-8'))) return true;
      } catch {
        // Ignore unreadable generated files; other validation steps will catch concrete runtime failures.
      }
    }
  }

  return false;
}

function frontendRuntimeFindings(html: string) {
  const findings: string[] = [];
  const checks = [
    { pattern: /unable to load (?:products|items|data)|failed to fetch (?:products|items|data)|error fetching (?:products|items|data)/i, message: 'frontend rendered a data/API failure message' },
    { pattern: /404\s+this page could not be found|this page could not be found/i, message: 'frontend rendered a Next.js 404 page' },
    { pattern: /hydration failed|application error|runtime error/i, message: 'frontend rendered a runtime error state' }
  ];

  for (const check of checks) {
    if (check.pattern.test(html)) findings.push(check.message);
  }

  return findings;
}

function extractNextImageUrls(html: string, baseUrl: string) {
  const urls = new Set<string>();
  const matches = Array.from(html.matchAll(/\/_next\/image\?[^"'<>\s,)]+/gi));

  for (const match of matches) {
    const raw = match[0].replace(/&amp;/g, '&').replace(/&#x26;/g, '&');
    try {
      urls.add(new URL(raw, baseUrl).toString());
    } catch {
      // Ignore malformed candidates; they will be represented by broken UI checks where applicable.
    }
  }

  return Array.from(urls);
}

function addResolvedImageUrl(urls: Set<string>, rawUrl: string, baseUrl: string) {
  const trimmed = rawUrl.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || /^(?:data|blob|mailto|javascript):/iu.test(trimmed)) return;

  try {
    urls.add(new URL(trimmed.replace(/&amp;/g, '&').replace(/&#x26;/g, '&'), baseUrl).toString());
  } catch {
    // Ignore malformed candidates; browser evidence will represent visible failures.
  }
}

function extractRenderedImageUrls(html: string, baseUrl: string) {
  const urls = new Set<string>(extractNextImageUrls(html, baseUrl));

  for (const match of Array.from(html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu))) {
    addResolvedImageUrl(urls, match[1], baseUrl);
  }

  for (const match of Array.from(html.matchAll(/<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/giu))) {
    for (const candidate of match[1].split(',')) {
      addResolvedImageUrl(urls, candidate.trim().split(/\s+/u)[0] || '', baseUrl);
    }
  }

  for (const match of Array.from(html.matchAll(/<link\b[^>]*\bas=["']image["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu))) {
    addResolvedImageUrl(urls, match[1], baseUrl);
  }

  for (const match of Array.from(html.matchAll(/\burl\(([^)]+)\)/giu))) {
    const candidate = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (IMAGE_ASSET_EXTENSIONS.has(path.extname(candidate.split(/[?#]/u)[0] || '').toLowerCase())) {
      addResolvedImageUrl(urls, candidate, baseUrl);
    }
  }

  return Array.from(urls);
}

function validateImageResponseSignature(url: string, contentType: string | null, buffer: Buffer) {
  const actual = sniffImageFormat(buffer);
  const responseFormat = imageFormatFromContentType(contentType);
  const extensionFormat = imageFormatFromExtension(new URL(url).pathname);

  if (actual === 'unknown') {
    return `${url} returned ${contentType || 'unknown content-type'} but the response body is not a recognized image format.`;
  }

  if (responseFormat !== 'unknown' && responseFormat !== actual) {
    return `${url} returned content-type ${contentType}, but the response body is ${imageFormatLabel(actual)}.`;
  }

  if (extensionFormat && extensionFormat !== actual) {
    return `${url} has a ${path.extname(new URL(url).pathname)} extension, but the response body is ${imageFormatLabel(actual)}.`;
  }

  return null;
}

async function validateRenderedImageUrls(name: string, html: string, baseUrl: string, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  const imageUrls = extractRenderedImageUrls(html, baseUrl).slice(0, 20);
  if (imageUrls.length === 0) {
    return skippedStep(name, 'No rendered image URLs were found in the page HTML.');
  }

  const failures: string[] = [];
  for (const url of imageUrls) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal });
      if (!response.ok) {
        const body = await response.text();
        failures.push(`${url} returned ${response.status}: ${truncate(body, 500)}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const signatureFailure = validateImageResponseSignature(url, response.headers.get('content-type'), buffer);
      if (signatureFailure) failures.push(signatureFailure);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failures.length > 0
    ? {
        name,
        status: 'FAIL',
        command: imageUrls.map((url) => `GET ${url}`).join(' && '),
        message: `Rendered image URLs must be fetchable and decodable. Failures:\n${failures.join('\n')}`
      }
    : {
        name,
        status: 'PASS',
        command: imageUrls.map((url) => `GET ${url}`).join(' && '),
        message: `Checked ${imageUrls.length} rendered image URL(s) for HTTP status and image signatures.`
      };
}

async function validateNextImageUrls(name: string, html: string, baseUrl: string, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  return validateRenderedImageUrls(name, html, baseUrl, signal);
}

async function validateBackendProductApi(codeDir: string, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  if (!(await hasGeneratedProductContract(codeDir))) {
    return skippedStep('backend product API smoke', 'No generated product API or product detail route contract was detected.');
  }

  const urls = backendBaseUrls().map((baseUrl) => urlWithPath(baseUrl, '/api/products'));
  const response = await fetchFirstOk(urls, signal);
  if (!response.ok) {
    return {
      name: 'backend product API smoke',
      status: 'FAIL',
      command: urls.map((url) => `GET ${url}`).join(' || '),
      message: `Generated files reference a product API, but /api/products is not reachable. ${response.message}`
    };
  }

  try {
    const data = JSON.parse(response.body);
    if (!Array.isArray(data) || data.length === 0) {
      return {
        name: 'backend product API smoke',
        status: 'FAIL',
        command: `GET ${response.url}`,
        message: '/api/products must return a non-empty JSON array when product listing/detail UI is generated.'
      };
    }
  } catch {
    return {
      name: 'backend product API smoke',
      status: 'FAIL',
      command: `GET ${response.url}`,
      message: `/api/products returned non-JSON content: ${truncate(response.body, 500)}`
    };
  }

  return {
    name: 'backend product API smoke',
    status: 'PASS',
    command: `GET ${response.url}`,
    message: '/api/products returned a non-empty JSON array.'
  };
}

async function validateBackendCorsForFrontendOrigins(codeDir: string, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  if (!(await hasGeneratedProductContract(codeDir))) {
    return skippedStep('backend CORS browser-origin smoke', 'No generated browser product/API contract was detected.');
  }

  const apiUrls = backendBaseUrls().map((baseUrl) => urlWithPath(baseUrl, '/api/products'));
  const frontendOrigins = Array.from(new Set(frontendBaseUrls().map((baseUrl) => new URL(baseUrl).origin)));
  const failures: string[] = [];
  const passes: string[] = [];

  for (const origin of frontendOrigins) {
    let originPassed = false;
    const originFailures: string[] = [];

    for (const apiUrl of apiUrls) {
      try {
        const response = await fetch(apiUrl, {
          cache: 'no-store',
          headers: { Origin: origin },
          signal
        });
        const allowOrigin = response.headers.get('access-control-allow-origin');
        if (response.ok && (allowOrigin === origin || allowOrigin === '*')) {
          passes.push(`${origin} -> ${apiUrl} allowed by ${allowOrigin}`);
          originPassed = true;
          break;
        }

        originFailures.push(`${origin} -> ${apiUrl} returned ${response.status} with access-control-allow-origin=${allowOrigin || '(missing)'}`);
      } catch (error) {
        originFailures.push(`${origin} -> ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!originPassed) {
      failures.push(...originFailures);
      failures.push(`Generated backend does not allow browser origin ${origin} for /api/products.`);
    }
  }

  return failures.length > 0
    ? {
        name: 'backend CORS browser-origin smoke',
        status: 'FAIL',
        command: frontendOrigins.map((origin) => `GET /api/products Origin:${origin}`).join(' && '),
        message: `Backend API must allow the generated frontend origins used by browser validation. Failures:\n${failures.join('\n')}`
      }
    : {
        name: 'backend CORS browser-origin smoke',
        status: 'PASS',
        command: frontendOrigins.map((origin) => `GET /api/products Origin:${origin}`).join(' && '),
        message: `Backend CORS allows generated frontend origins:\n${passes.join('\n')}`
      };
}

function productDetailPathFromProduct(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const product = value as Record<string, unknown>;
  const rawId = product.id ?? product.productId ?? product.productID ?? product._id ?? product.slug;
  const id = typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  return id ? `/products/${encodeURIComponent(id)}` : null;
}

function productDetailPathFromProductsPayload(body: string) {
  try {
    const payload = JSON.parse(body) as unknown;
    const products = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? (['products', 'items', 'data', 'content'] as const)
            .map((key) => (payload as Record<string, unknown>)[key])
            .find((value): value is unknown[] => Array.isArray(value))
        : null;
    return products?.map(productDetailPathFromProduct).find((value): value is string => Boolean(value)) ?? null;
  } catch {
    return null;
  }
}

async function firstBackendProductDetailPath(signal?: AbortSignal) {
  const urls = backendBaseUrls().map((baseUrl) => urlWithPath(baseUrl, '/api/products'));
  const response = await fetchFirstOk(urls, signal);
  return response.ok ? productDetailPathFromProductsPayload(response.body) : null;
}

function extractFirstProductDetailPath(html: string) {
  const match = html.match(/href=["'](\/products\/[^"']+)["']/i);
  return match?.[1] ?? null;
}

async function validateFrontendRuntimeSmoke(codeDir: string, logDir: string, signal?: AbortSignal): Promise<GeneratedValidationStep[]> {
  const steps: GeneratedValidationStep[] = [];
  const homeUrls = frontendBaseUrls();
  const preparedMediaAssets = await readPreparedMediaAssetsManifest(codeDir);
  const preparedAssetReferences = preparedMediaAssetReferences(preparedMediaAssets);
  const home = await fetchFirstOk(homeUrls, signal);

  if (!home.ok) {
    return [
      {
        name: 'frontend rendered content smoke',
        status: 'FAIL',
        command: homeUrls.map((url) => `GET ${url}`).join(' || '),
        message: `Frontend route did not return usable HTML. ${home.message}`
      }
    ];
  }

  const homeFindings = frontendRuntimeFindings(extractVisibleTextFromHtml(home.body));
  steps.push(
    homeFindings.length > 0
      ? {
          name: 'frontend rendered content smoke',
          status: 'FAIL',
          command: `GET ${home.url}`,
          message: `Frontend returned 200 but rendered blocking runtime/data failure(s): ${homeFindings.join('; ')}.`
        }
      : {
          name: 'frontend rendered content smoke',
          status: 'PASS',
          command: `GET ${home.url}`,
          message: 'Frontend home route returned 200 without obvious runtime/data failure text.'
        }
  );

  steps.push(await validateRenderedImageUrls('frontend home image smoke', home.body, home.url, signal));
  steps.push(await validatePreparedMediaAssetUsage(codeDir, preparedMediaAssets));

  const hasProductDetailRoute = (await hasGeneratedProductContract(codeDir)) || /href=["']\/products\//i.test(home.body);
  steps.push(
    await validateBrowserRenderedPage({
      name: 'frontend browser home smoke',
      url: home.url,
      codeDir,
      logDir,
      signal,
      expectProductList: hasProductDetailRoute,
      preparedAssetReferences
    })
  );

  if (!hasProductDetailRoute) {
    steps.push(skippedStep('frontend product detail smoke', 'No generated product detail route was detected.'));
    return steps;
  }

  const detailPath = extractFirstProductDetailPath(home.body) ?? (await firstBackendProductDetailPath(signal));
  if (!detailPath) {
    steps.push({
      name: 'frontend product detail smoke',
      status: 'FAIL',
      command: `scan frontend HTML for /products/<id> links or GET ${backendBaseUrls().map((baseUrl) => urlWithPath(baseUrl, '/api/products')).join(' || GET ')}`,
      message: 'Generated product detail route was detected, but validation could not derive a concrete /products/<id> path from rendered HTML or the first backend product payload.'
    });
    return steps;
  }

  const detailUrls = frontendBaseUrls().map((baseUrl) => urlWithPath(baseUrl, detailPath));
  const detail = await fetchFirstOk(detailUrls, signal);
  if (!detail.ok) {
    steps.push({
      name: 'frontend product detail smoke',
      status: 'FAIL',
      command: detailUrls.map((url) => `GET ${url}`).join(' || '),
      message: `Generated product detail route is not reachable at ${detailPath}. ${detail.message}`
    });
    return steps;
  }

  const detailFindings = frontendRuntimeFindings(extractVisibleTextFromHtml(detail.body));
  steps.push(
    detailFindings.length > 0
      ? {
          name: 'frontend product detail smoke',
          status: 'FAIL',
          command: `GET ${detail.url}`,
          message: `Product detail route returned 200 but rendered blocking runtime/data failure(s): ${detailFindings.join('; ')}.`
        }
      : {
          name: 'frontend product detail smoke',
          status: 'PASS',
          command: `GET ${detail.url}`,
          message: `Product detail route ${detailPath} returned 200 without obvious runtime/data failure text.`
        }
  );
  steps.push(await validateRenderedImageUrls('frontend detail image smoke', detail.body, detail.url, signal));
  steps.push(
    await validateBrowserRenderedPage({
      name: 'frontend browser product detail smoke',
      url: detail.url,
      codeDir,
      logDir,
      signal,
      expectProductDetail: true,
      preparedAssetReferences
    })
  );

  return steps;
}

function runtimeLogFindings(output: string) {
  const findings: string[] = [];
  const checks = [
    { pattern: /Error fetching (?:products|product|items|item|data)/i, message: 'frontend server logs contain generated data fetch errors' },
    { pattern: /TypeError:\s*fetch failed/i, message: 'frontend server logs contain fetch failed errors' },
    { pattern: /ECONNREFUSED[\s\S]{0,300}(?:localhost|127\.0\.0\.1):(55080|8000|8080|8081)|(?:localhost|127\.0\.0\.1):(55080|8000|8080|8081)[\s\S]{0,300}ECONNREFUSED/i, message: 'frontend container appears to call localhost for the backend instead of the Compose service name' },
    { pattern: /url["']?\s+parameter is not allowed|INVALID_IMAGE_OPTIMIZE_REQUEST|upstream image response failed|ImageError/i, message: 'frontend server logs contain image optimization failures' }
  ];

  for (const check of checks) {
    if (check.pattern.test(output)) findings.push(check.message);
  }

  return findings;
}

async function validateRuntimeLogs(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string, signal?: AbortSignal): Promise<GeneratedValidationStep> {
  const logs = await collectComposeLogsForEngine(engine, codeDir, composeFile, logDir, signal);
  const findings = runtimeLogFindings(logs.output);

  return findings.length > 0
    ? {
        name: `${engine.name} runtime log smoke`,
        status: 'FAIL',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')}`,
        logFile: logs.logFile,
        message: `Runtime logs contain blocking generated-app failures: ${findings.join('; ')}.\n${truncate(logs.output, 2400)}`
      }
    : {
        name: `${engine.name} runtime log smoke`,
        status: 'PASS',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')}`,
        logFile: logs.logFile,
        message: 'Runtime logs do not contain known blocking generated-app fetch or image failures.'
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
  if (shouldRemoveGeneratedComposeVolumes()) {
    args.push('--volumes');
  }
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
        ? [
            'Removed previous generated Compose containers, networks, and orphans for this project name',
            shouldRemoveGeneratedComposeVolumes() ? 'removed generated volumes to avoid stale SQLite/runtime data' : '',
            shouldRemoveGeneratedComposeImages() ? 'removed local generated images' : ''
          ]
            .filter(Boolean)
            .join('; ') + '.'
        : step.message
  };
}

interface ComposeHostPortMapping {
  service: string;
  hostPort: number;
  containerPort?: number;
  protocol?: string;
  raw: string;
}

interface HostPortOwner {
  name: string;
  ports: string;
}

function parseComposePortNumber(value: string | undefined) {
  if (!value) return null;
  const normalized = value.trim().replace(/^["']|["']$/g, '');
  const envDefault = normalized.match(/^\$\{[A-Z0-9_]+:-(\d+)\}$/iu);
  if (envDefault) return Number(envDefault[1]);
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseShortComposePort(rawValue: string, service: string): ComposeHostPortMapping | null {
  const raw = rawValue.trim().replace(/^["']|["']$/g, '').replace(/\/[a-z]+$/iu, '');
  if (!raw || raw.startsWith('mode:')) return null;

  const parts = raw.split(':');
  if (parts.length < 2) return null;

  const hostPart = parts[parts.length - 2];
  const containerPart = parts[parts.length - 1];
  const hostPort = parseComposePortNumber(hostPart);
  if (!hostPort) return null;

  return {
    service,
    hostPort,
    containerPort: parseComposePortNumber(containerPart) ?? undefined,
    raw: rawValue.trim()
  };
}

function parseComposeConfigHostPorts(configOutput: string): ComposeHostPortMapping[] {
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
        protocol: pending.protocol,
        raw: pending.raw || `${pending.hostPort}:${pending.containerPort || ''}`
      });
    }
    pending = null;
  };

  for (const line of configOutput.split(/\r?\n/u)) {
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
      const shortPort = parseShortComposePort(itemMatch[1], currentService);
      if (shortPort) {
        mappings.push(shortPort);
      } else {
        pending = { service: currentService, raw: itemMatch[1].trim() };
      }
      continue;
    }

    const propertyMatch = line.match(/^ {8}(published|target|protocol):\s*(.+?)\s*$/u);
    if (propertyMatch && pending) {
      const key = propertyMatch[1];
      const value = propertyMatch[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'published') pending.hostPort = parseComposePortNumber(value) ?? undefined;
      if (key === 'target') pending.containerPort = parseComposePortNumber(value) ?? undefined;
      if (key === 'protocol') pending.protocol = value;
    }
  }

  flushPending();
  return mappings;
}

function parseDockerPortOwners(output: string): Map<number, HostPortOwner[]> {
  const owners = new Map<number, HostPortOwner[]>();
  for (const line of output.split(/\r?\n/u)) {
    const [name, ports = ''] = line.split('\t');
    if (!name?.trim()) continue;

    for (const match of Array.from(ports.matchAll(/(?:(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::1):)(\d+)->/gu))) {
      const port = Number(match[1]);
      if (!Number.isFinite(port)) continue;
      const list = owners.get(port) ?? [];
      list.push({ name: name.trim(), ports: ports.trim() });
      owners.set(port, list);
    }
  }

  return owners;
}

async function listHostPortOwners(engine: ComposeEngine, codeDir: string, signal?: AbortSignal) {
  const result = await runCommand(engine.command, ['ps', '--format', '{{.Names}}\t{{.Ports}}'], codeDir, 30_000, undefined, signal);
  if (!result.ok) return new Map<number, HostPortOwner[]>();
  return parseDockerPortOwners(result.output);
}

function canBindHostPort(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function portMappingLabel(mapping: ComposeHostPortMapping) {
  const target = mapping.containerPort ? ` -> container ${mapping.containerPort}` : '';
  return `${mapping.service} host ${mapping.hostPort}${target}`;
}

function generatedServiceKind(service: string) {
  const normalized = service.toLowerCase();
  if (normalized === 'frontend' || normalized.includes('front') || normalized.includes('web') || normalized.includes('ui')) return 'frontend';
  if (normalized === 'backend' || normalized.includes('back') || normalized.includes('api') || normalized.includes('server')) return 'backend';
  return 'other';
}

function nonGeneratedOwners(owners: HostPortOwner[] | undefined) {
  return (owners ?? []).filter((owner) => !owner.name.startsWith(`${COMPOSE_PROJECT_NAME}-`));
}

async function validateComposeHostPortPreflight(
  engine: ComposeEngine,
  codeDir: string,
  composeFile: string,
  logDir: string,
  signal?: AbortSignal
): Promise<GeneratedValidationStep> {
  const config = await runCommand(engine.command, [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'], codeDir, 30_000, undefined, signal);
  if (!config.ok) {
    return {
      name: `${engine.name} host port preflight`,
      status: 'FAIL',
      command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'].join(' ')}`,
      message: `Could not resolve Compose ports before startup.\n${config.error || 'Command failed.'}\n${truncate(maskSecrets(config.output), 2_000)}`
    };
  }

  const mappings = parseComposeConfigHostPorts(config.output);
  if (mappings.length === 0) {
    return skippedStep(`${engine.name} host port preflight`, 'Compose config does not publish host ports.');
  }

  const frontendMapping = mappings.find((mapping) => generatedServiceKind(mapping.service) === 'frontend');
  const backendMapping = mappings.find((mapping) => generatedServiceKind(mapping.service) === 'backend');
  const expectedMismatches = [
    frontendMapping && frontendMapping.hostPort !== getFrontendPort()
      ? `frontend publishes host ${frontendMapping.hostPort}, but GENERATED_FRONTEND_PORT expects ${getFrontendPort()}`
      : '',
    backendMapping && backendMapping.hostPort !== getBackendPort()
      ? `backend publishes host ${backendMapping.hostPort}, but GENERATED_BACKEND_PORT expects ${getBackendPort()}`
      : ''
  ].filter(Boolean);

  if (expectedMismatches.length > 0) {
    const logFile = await writeLog(
      logDir,
      `${engine.name.replace(/\s+/g, '-')}-validation-port-contract`,
      [
        'Generated Compose ports do not match execution validation ports:',
        ...expectedMismatches.map((mismatch) => `- ${mismatch}`),
        '',
        'Repair guidance:',
        '- Keep generated Compose, .env.example, frontend browser API URLs, and the app-level GENERATED_* validation env aligned.',
        `- Default generated app ports are frontend ${DEFAULT_GENERATED_FRONTEND_HOST_PORT}, backend ${DEFAULT_GENERATED_BACKEND_HOST_PORT}, and database ${DEFAULT_GENERATED_DATABASE_HOST_PORT}.`
      ].join('\n')
    );

    return {
      name: `${engine.name} validation port contract`,
      status: 'FAIL',
      command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'].join(' ')}`,
      logFile,
      message: `Execution validation is configured for different host ports than generated Compose publishes:\n${expectedMismatches.map((mismatch) => `- ${mismatch}`).join('\n')}`
    };
  }

  const ownersByPort = await listHostPortOwners(engine, codeDir, signal);
  const conflicts: string[] = [];
  for (const mapping of mappings) {
    const allOwners = ownersByPort.get(mapping.hostPort);
    const owners = nonGeneratedOwners(allOwners);
    if (owners.length > 0) {
      conflicts.push(`${portMappingLabel(mapping)} is already published by ${owners.map((owner) => `${owner.name} (${owner.ports})`).join(', ')}`);
      continue;
    }

    if (allOwners?.some((owner) => owner.name.startsWith(`${COMPOSE_PROJECT_NAME}-`))) {
      continue;
    }

    if (!(await canBindHostPort(mapping.hostPort))) {
      conflicts.push(`${portMappingLabel(mapping)} is already in use by a local process or Docker proxy that is not part of ${COMPOSE_PROJECT_NAME}.`);
    }
  }

  if (conflicts.length > 0) {
    const logFile = await writeLog(
      logDir,
      `${engine.name.replace(/\s+/g, '-')}-host-port-preflight`,
      [
        'Generated Compose host port conflicts:',
        ...conflicts.map((conflict) => `- ${conflict}`),
        '',
        `This validator only cleans up the generated Compose project (${COMPOSE_PROJECT_NAME}). It will not stop unrelated containers or local processes.`,
        `Use generated-app host ports in the 55xxx range, such as frontend ${DEFAULT_GENERATED_FRONTEND_HOST_PORT}, backend ${DEFAULT_GENERATED_BACKEND_HOST_PORT}, and database ${DEFAULT_GENERATED_DATABASE_HOST_PORT}.`
      ].join('\n')
    );

    return {
      name: `${engine.name} host port preflight`,
      status: 'FAIL',
      command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'].join(' ')} && ${engine.command} ps --format ...`,
      logFile,
      message: `Generated Compose cannot start because required host ports are occupied by unrelated runtime resources:\n${conflicts.map((conflict) => `- ${conflict}`).join('\n')}`
    };
  }

  return {
    name: `${engine.name} host port preflight`,
    status: 'PASS',
    command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'].join(' ')} && ${engine.command} ps --format ...`,
    message: `Host ports are available for generated Compose: ${mappings.map(portMappingLabel).join(', ')}.`
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

    const hostPortPreflight = await validateComposeHostPortPreflight(engine, codeDir, composeFile, logDir, signal);
    steps.push(hostPortPreflight);
    if (hostPortPreflight.status === 'FAIL') {
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'FAIL',
        level: 'error',
        message: 'Generated Compose host port preflight failed before startup. Free the unrelated port owner or update generated host ports.'
      });
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
        message: composeDiagnosticsMessage(engine.name, 'startup failure', logs.output)
      });
      return steps;
    }

    const backendHealth = await waitForHttp(
      'backend health',
      backendHealthUrls(),
      HEALTH_TIMEOUT_MS,
      onProgress,
      signal
    );
    steps.push(backendHealth);

    const frontendHealth = await waitForHttp(
      'frontend health',
      frontendBaseUrls(),
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
        message: composeDiagnosticsMessage(engine.name, 'healthcheck failure', logs.output)
      });
      return steps;
    }

    const runtimeSmokeSteps: GeneratedValidationStep[] = [
      await validateBackendProductApi(codeDir, signal),
      await validateBackendCorsForFrontendOrigins(codeDir, signal),
      ...(await validateFrontendRuntimeSmoke(codeDir, logDir, signal)),
      await validateRuntimeLogs(engine, codeDir, composeFile, logDir, signal)
    ];
    steps.push(...runtimeSmokeSteps);

    if (runtimeSmokeSteps.some((step) => step.status === 'FAIL')) {
      const logs = await collectComposeDiagnosticsForEngine(engine, codeDir, composeFile, logDir, signal);
      steps.push({
        name: `${engine.name} diagnostics`,
        status: 'FAIL',
        command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')} && ${engine.command} ps/inspect`,
        logFile: logs.logFile,
        message: composeDiagnosticsMessage(engine.name, 'runtime smoke failure', logs.output)
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

function shouldRunLocalValidationAfterCompose(composeSteps: GeneratedValidationStep[]) {
  if (!shouldFallbackToLocalValidationWhenComposeSkipped()) return false;
  if (composeSteps.some((step) => step.status === 'FAIL')) return false;

  return composeSteps.some((step) => {
    if (step.status !== 'SKIPPED') return false;
    const target = `${step.name}\n${step.message}`;
    return /allow_generated_docker=false|environment\/runtime issue|rancher\/docker|docker\/rancher|compose engine|local compose engine|docker compose execution was skipped|not ready|unavailable|not available/i.test(
      target
    );
  });
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
  const status = failedSteps.length > 0 ? 'NEEDS_FIX' : params.skipped || allExecutionSkipped || hasInfrastructureSkip ? 'SKIPPED' : 'PASS';

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

  const steps: GeneratedValidationStep[] = [await copyEnvExampleIfSafe(codeDir), await validateStaticImageAssetIntegrity(codeDir, logDir)];
  if (steps.some((step) => step.status === 'FAIL')) {
    return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
  }

  const composeFile = await resolveComposeFile(codeDir);

  if (composeFile) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      message: `Compose file detected: ${composeFile}.`
    });
    const composeSteps = await validateWithDockerCompose(codeDir, composeFile, logDir, onProgress, signal);
    steps.push(...composeSteps);

    if (shouldRunLocalValidationAfterCompose(composeSteps)) {
      await onProgress?.({
        stepId: 'execution-validation',
        stepStatus: 'RUNNING',
        level: 'warn',
        message: 'Compose validation was skipped because Docker/Rancher is unavailable. Running local Node/Python validation instead.'
      });
      steps.push(...(await validateLocalNode(codeDir, logDir, onProgress, signal)));
      steps.push(...(await validateLocalPython(codeDir, logDir, onProgress, signal)));
    }

    return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
  }

  steps.push(...(await validateLocalNode(codeDir, logDir, onProgress, signal)));
  steps.push(...(await validateLocalPython(codeDir, logDir, onProgress, signal)));

  return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
}
