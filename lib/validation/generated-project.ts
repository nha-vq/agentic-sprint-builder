import type { DevOutput } from '@/lib/types';

export interface GeneratedProjectValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
  fixInstructions: string;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').toLowerCase();
}

function getFile(output: DevOutput, filePath: string) {
  const normalized = normalizePath(filePath);
  return output.files.find((file) => normalizePath(file.path) === normalized);
}

function hasFile(output: DevOutput, filePath: string) {
  return Boolean(getFile(output, filePath));
}

function hasAnyPath(output: DevOutput, prefix: string) {
  const normalizedPrefix = normalizePath(prefix);
  return output.files.some((file) => normalizePath(file.path).startsWith(normalizedPrefix));
}

function parseJson(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function validateGeneratedProject(output: DevOutput): GeneratedProjectValidation {
  const findings: string[] = [];
  const hasFrontend = hasAnyPath(output, 'frontend/') || output.files.some((file) => /next|react/i.test(file.content));
  const hasBackend = hasAnyPath(output, 'backend/') || output.files.some((file) => /fastapi|sqlmodel|uvicorn/i.test(file.content));

  if (hasFrontend) {
    const packageJson = getFile(output, 'frontend/package.json');
    if (!packageJson) {
      findings.push('Frontend appears to be generated but frontend/package.json is missing.');
    } else {
      const parsed = parseJson(packageJson.content);
      const scripts = parsed?.scripts ?? {};
      const dependencies = parsed?.dependencies ?? {};

      if (!scripts.dev || !scripts.build || !scripts.start) {
        findings.push('frontend/package.json must include dev, build, and start scripts.');
      }

      for (const dependency of ['next', 'react', 'react-dom']) {
        if (!dependencies[dependency]) {
          findings.push(`frontend/package.json is missing dependency ${dependency}.`);
        }
      }
    }

    const usesTailwind = output.files.some((file) => /@tailwind|tailwindcss/i.test(file.content));
    if (usesTailwind) {
      if (!hasFile(output, 'frontend/tailwind.config.js') && !hasFile(output, 'frontend/tailwind.config.ts')) {
        findings.push('Frontend uses Tailwind but is missing frontend/tailwind.config.js or frontend/tailwind.config.ts.');
      }

      if (!hasFile(output, 'frontend/postcss.config.js') && !hasFile(output, 'frontend/postcss.config.mjs')) {
        findings.push('Frontend uses Tailwind but is missing frontend/postcss.config.js or frontend/postcss.config.mjs.');
      }
    }
  }

  if (hasBackend) {
    const requirements = getFile(output, 'backend/requirements.txt');
    if (!requirements) {
      findings.push('Backend appears to be FastAPI/Python but backend/requirements.txt is missing.');
    } else {
      for (const dependency of ['fastapi', 'uvicorn']) {
        if (!requirements.content.toLowerCase().includes(dependency)) {
          findings.push(`backend/requirements.txt is missing ${dependency}.`);
        }
      }
    }

    const main = getFile(output, 'backend/app/main.py');
    if (!main) {
      findings.push('Backend is missing backend/app/main.py app entrypoint.');
    } else if (hasFrontend && !/CORSMiddleware|allow_origins/i.test(main.content)) {
      findings.push('Backend should configure CORS for the frontend dev port.');
    }
  }

  if (hasFrontend && hasBackend && !/8000|api base|api_base|NEXT_PUBLIC_API/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should explain the backend API port and frontend API base URL.');
  }

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix these run/build readiness blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : ''
  };
}
