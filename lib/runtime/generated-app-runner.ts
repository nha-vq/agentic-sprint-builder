import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import type { GeneratedRuntimeResult, GeneratedRuntimeServiceResult, RunProgressReporter } from '@/lib/types';

const DEFAULT_BACKEND_PORT = 8000;
const DEFAULT_FRONTEND_PORT = 3001;
const STARTUP_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

let activeProcesses: ChildProcess[] = [];

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function commandName(name: string) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function getPythonCommand() {
  return process.env.PYTHON || 'python';
}

function getBackendPort() {
  return Number(process.env.GENERATED_BACKEND_PORT || DEFAULT_BACKEND_PORT);
}

function getFrontendPort() {
  return Number(process.env.GENERATED_FRONTEND_PORT || DEFAULT_FRONTEND_PORT);
}

function shouldAutoRunGeneratedApp() {
  return process.env.AUTO_RUN_GENERATED_APP !== 'false';
}

async function pathExists(target: string) {
  try {
    await fsPromises.access(target);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], cwd: string, timeout: number) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd, timeout }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopProcessTree(child: ChildProcess) {
  if (!child.pid || child.killed) return;

  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }

  await new Promise<void>((resolve) => {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
  });
}

async function stopActiveProcesses() {
  const processes = activeProcesses;
  activeProcesses = [];
  await Promise.all(processes.map((child) => stopProcessTree(child)));
}

function spawnService(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  logFile: string;
}) {
  const output = fs.createWriteStream(params.logFile, { flags: 'a' });
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: { ...process.env, ...params.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });
  child.on('close', (code, signal) => {
    output.write(`\n[process exited code=${code ?? 'null'} signal=${signal ?? 'null'}]\n`);
    output.end();
  });

  activeProcesses.push(child);
  return child;
}

async function waitForHttp(urls: string[], timeoutMs = STARTUP_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < timeoutMs) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        return response.url;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(lastError || `Service did not respond within ${timeoutMs}ms.`);
}

function skippedService(name: 'backend' | 'frontend', cwd: string, message: string): GeneratedRuntimeServiceResult {
  return {
    name,
    status: 'SKIPPED',
    cwd,
    command: '',
    message
  };
}

async function startBackend(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedRuntimeServiceResult> {
  const backendDir = path.join(codeDir, 'backend');
  const requirementsPath = path.join(backendDir, 'requirements.txt');
  const mainPath = path.join(backendDir, 'app', 'main.py');

  if (!(await pathExists(backendDir))) {
    return skippedService('backend', backendDir, 'No generated backend directory found.');
  }

  if (!(await pathExists(requirementsPath)) || !(await pathExists(mainPath))) {
    return skippedService('backend', backendDir, 'Generated backend is not a FastAPI project with requirements.txt and app/main.py.');
  }

  const python = getPythonCommand();
  const venvDir = path.join(backendDir, '.venv');
  const venvPython =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
  const port = getBackendPort();
  const logFile = path.join(logDir, 'backend.log');
  let child: ChildProcess | undefined;

  try {
    if (!(await pathExists(venvPython))) {
      await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', message: 'Creating backend Python virtual environment.' });
      await runCommand(python, ['-m', 'venv', '.venv'], backendDir, INSTALL_TIMEOUT_MS);
    }

    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', message: 'Installing backend dependencies.' });
    await runCommand(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], backendDir, INSTALL_TIMEOUT_MS);

    const args = ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)];
    child = spawnService({
      command: venvPython,
      args,
      cwd: backendDir,
      logFile
    });
    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', message: `Starting backend on port ${port}.` });
    const url = await waitForHttp([`http://127.0.0.1:${port}/health`, `http://127.0.0.1:${port}/`]);
    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', level: 'success', message: `Backend responded at ${url}.` });

    return {
      name: 'backend',
      status: 'RUNNING',
      cwd: backendDir,
      command: `${venvPython} ${args.join(' ')}`,
      url,
      port,
      pid: child.pid,
      logFile,
      message: 'Generated backend is running.'
    };
  } catch (error) {
    if (child) await stopProcessTree(child);
    return {
      name: 'backend',
      status: 'FAILED',
      cwd: backendDir,
      command: `${venvPython} -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`,
      port,
      logFile,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function startFrontend(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedRuntimeServiceResult> {
  const frontendDir = path.join(codeDir, 'frontend');
  const packageJsonPath = path.join(frontendDir, 'package.json');

  if (!(await pathExists(frontendDir))) {
    return skippedService('frontend', frontendDir, 'No generated frontend directory found.');
  }

  if (!(await pathExists(packageJsonPath))) {
    return skippedService('frontend', frontendDir, 'Generated frontend does not include package.json.');
  }

  const npm = commandName('npm');
  const port = getFrontendPort();
  const logFile = path.join(logDir, 'frontend.log');
  let child: ChildProcess | undefined;

  try {
    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', message: 'Installing frontend dependencies.' });
    await runCommand(npm, ['install'], frontendDir, INSTALL_TIMEOUT_MS);

    const args = ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)];
    child = spawnService({
      command: npm,
      args,
      cwd: frontendDir,
      env: {
        PORT: String(port),
        NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${getBackendPort()}`
      },
      logFile
    });
    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', message: `Starting frontend on port ${port}.` });
    const url = await waitForHttp([`http://127.0.0.1:${port}/`]);
    await onProgress?.({ stepId: 'runtime', stepStatus: 'RUNNING', level: 'success', message: `Frontend responded at ${url}.` });

    return {
      name: 'frontend',
      status: 'RUNNING',
      cwd: frontendDir,
      command: `${npm} ${args.join(' ')}`,
      url,
      port,
      pid: child.pid,
      logFile,
      message: 'Generated frontend is running.'
    };
  } catch (error) {
    if (child) await stopProcessTree(child);
    return {
      name: 'frontend',
      status: 'FAILED',
      cwd: frontendDir,
      command: `${npm} run dev -- --hostname 127.0.0.1 --port ${port}`,
      port,
      logFile,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runGeneratedApp(onProgress?: RunProgressReporter): Promise<GeneratedRuntimeResult> {
  const startedAt = new Date().toISOString();
  const codeDir = getGeneratedCodeDir();
  const logDir = path.join(codeDir, '.runtime-logs');

  if (!shouldAutoRunGeneratedApp()) {
    return {
      startedAt,
      services: [
        skippedService('backend', path.join(codeDir, 'backend'), 'AUTO_RUN_GENERATED_APP=false.'),
        skippedService('frontend', path.join(codeDir, 'frontend'), 'AUTO_RUN_GENERATED_APP=false.')
      ]
    };
  }

  await fsPromises.mkdir(logDir, { recursive: true });
  await stopActiveProcesses();

  const backend = await startBackend(codeDir, logDir, onProgress);
  const frontend = await startFrontend(codeDir, logDir, onProgress);

  return {
    startedAt,
    services: [backend, frontend]
  };
}
