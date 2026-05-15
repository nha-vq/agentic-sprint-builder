import type { DevOutput, GeneratedFile } from '@/lib/types';

export interface GeneratedProjectValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
  fixInstructions: string;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function fileName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index).toLowerCase() : '.';
}

function parseJson(content: string): Record<string, any> | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function filesNamed(output: DevOutput, namePattern: RegExp) {
  return output.files.filter((file) => namePattern.test(fileName(file.path)));
}

function filesMatching(output: DevOutput, predicate: (file: GeneratedFile) => boolean) {
  return output.files.filter(predicate);
}

function textIncludes(output: DevOutput, pattern: RegExp) {
  return output.files.some((file) => pattern.test(file.content)) || pattern.test(output.setupInstructions) || pattern.test(output.architecture);
}

function getPackageJsonFiles(output: DevOutput) {
  return filesNamed(output, /^package\.json$/).map((file) => ({ file, parsed: parseJson(file.content) })).filter((item) => item.parsed);
}

function getFrontendPackages(output: DevOutput) {
  return getPackageJsonFiles(output).filter(({ parsed }) => {
    const dependencies = { ...(parsed?.dependencies ?? {}), ...(parsed?.devDependencies ?? {}) };
    return ['next', 'react', 'vite', '@vitejs/plugin-react'].some((dependency) => dependencies[dependency]);
  });
}

function getBackendManifests(output: DevOutput) {
  return filesMatching(output, (file) => {
    const name = fileName(file.path);
    const content = file.content.toLowerCase();
    return (
      name === 'requirements.txt' ||
      name === 'pyproject.toml' ||
      name === 'poetry.lock' ||
      content.includes('fastapi') ||
      content.includes('uvicorn') ||
      content.includes('sqlmodel')
    );
  });
}

function getComposeFile(output: DevOutput) {
  return filesNamed(output, /^(compose|docker-compose)\.ya?ml$/)[0];
}

function getDockerfiles(output: DevOutput) {
  return filesNamed(output, /^(dockerfile|containerfile)$/);
}

function hasTestFile(output: DevOutput, hint?: RegExp) {
  return output.files.some((file) => {
    const path = normalizePath(file.path);
    const content = file.content.toLowerCase();
    const looksLikeTest = /(^|\/)(tests?|__tests__)\/|(\.|_)(test|spec)\./.test(path);
    return looksLikeTest && (!hint || hint.test(content) || hint.test(path));
  });
}

function hasDockerfileNear(dockerfiles: GeneratedFile[], directory: string, contentHint: RegExp) {
  return dockerfiles.some((file) => {
    const dockerDir = dirName(file.path);
    return dockerDir === directory || contentHint.test(file.content);
  });
}

function hasConfigNear(output: DevOutput, directory: string, namePattern: RegExp) {
  return output.files.some((file) => namePattern.test(fileName(file.path)) && (dirName(file.path) === directory || directory === '.'));
}

export function validateGeneratedProject(output: DevOutput): GeneratedProjectValidation {
  const findings: string[] = [];
  const frontendPackages = getFrontendPackages(output);
  const backendManifests = getBackendManifests(output);
  const dockerfiles = getDockerfiles(output);
  const compose = getComposeFile(output);
  const composeContent = compose?.content ?? '';
  const hasFrontend = frontendPackages.length > 0 || textIncludes(output, /react|next\.config|vite/i);
  const hasBackend = backendManifests.length > 0 || textIncludes(output, /fastapi|uvicorn|sqlmodel|@app\.get/i);
  const hasDatabase = textIncludes(output, /database|database_url|db_host|sqlmodel|sqlalchemy|prisma|typeorm|sequelize|mongoose|mongodb|mysql|mariadb|postgres|postgresql|sqlite|migration/i);
  const hasOwnedDatabase = /(^|\n)\s{2,}[a-z0-9_-]+:\s*(\n[\s\S]*?image:\s*(postgres|mysql|mariadb|mongo|redis)|[\s\S]*?docker-entrypoint-initdb)/i.test(composeContent) || textIncludes(output, /project-owned database|local database|seed data|migrations?|schema initialization|create table/i);
  const hasExternalDatabase = textIncludes(output, /external database|existing database|pre-existing database|already available|provided database|managed database|connection string|database_url/i) && !hasOwnedDatabase;

  if (!filesNamed(output, /^readme\.md$/).length) {
    findings.push('Generated project should include a README with exact setup, build, run, test, and port instructions.');
  }

  if (!output.files.some((file) => fileName(file.path).endsWith('.env.example') || fileName(file.path) === '.env.example')) {
    findings.push('Generated project should include an env example file with safe local defaults and placeholders only.');
  }

  if (hasOwnedDatabase && !compose) {
    findings.push('Project-owned database services should include a Compose file or equivalent local database run instructions.');
  }

  if (compose) {
    if (hasBackend && !/healthcheck:/i.test(composeContent)) {
      findings.push('Compose configuration should include a backend healthcheck when a backend service is generated.');
    }

    if (hasOwnedDatabase && !/DATABASE_URL|DB_HOST|DB_PORT|DB_NAME|POSTGRES_|MYSQL_|MARIADB_|MONGO_/i.test(composeContent)) {
      findings.push('Compose configuration should wire database connection environment variables.');
    }
  }

  for (const { file, parsed } of frontendPackages) {
    const scripts = parsed?.scripts ?? {};
    const dependencies = parsed?.dependencies ?? {};
    const frontendDir = dirName(file.path);

    if (!scripts.dev || !scripts.build || !scripts.start || !scripts.test) {
      findings.push(`Frontend package at ${file.path} should include dev, build, start, and test scripts.`);
    }

    if (!scripts.lint) {
      findings.push(`Frontend package at ${file.path} should include a lint script when supported.`);
    }

    for (const dependency of ['react', 'react-dom']) {
      if (!dependencies[dependency]) {
        findings.push(`Frontend package at ${file.path} is missing dependency ${dependency}.`);
      }
    }

    if (!hasDockerfileNear(dockerfiles, frontendDir, /node|npm|yarn|pnpm/i)) {
      findings.push(`Frontend package at ${file.path} should have a nearby Dockerfile or container build file.`);
    }

    const usesTailwind = output.files.some((candidate) => dirName(candidate.path) === frontendDir && /@tailwind|tailwindcss/i.test(candidate.content)) || /tailwindcss/i.test(file.content);
    if (usesTailwind) {
      if (!hasConfigNear(output, frontendDir, /^tailwind\.config\.(js|ts|mjs|cjs)$/)) {
        findings.push(`Frontend package at ${file.path} uses Tailwind but no nearby Tailwind config was found.`);
      }

      if (!hasConfigNear(output, frontendDir, /^postcss\.config\.(js|mjs|cjs)$/)) {
        findings.push(`Frontend package at ${file.path} uses Tailwind but no nearby PostCSS config was found.`);
      }
    }
  }

  if (hasFrontend && frontendPackages.length === 0) {
    findings.push('Frontend code appears to be generated but no frontend package manifest was found.');
  }

  if (hasFrontend && hasBackend && !textIncludes(output, /NEXT_PUBLIC_API|VITE_API|PUBLIC_API|API_BASE_URL/i)) {
    findings.push('Frontend should use a configurable public API URL instead of hardcoded backend URLs.');
  }

  if (hasFrontend && !hasTestFile(output, /react|next|vite|page|frontend|browser|smoke/i)) {
    findings.push('Generated frontend should include at least one smoke test or documented test file.');
  }

  if (hasBackend && backendManifests.length === 0) {
    findings.push('Backend code appears to be generated but no backend dependency manifest was found.');
  }

  if (hasBackend) {
    const backendText = backendManifests.map((file) => file.content).join('\n').toLowerCase();
    if (!backendText.includes('fastapi')) {
      findings.push('Backend dependency manifest should include FastAPI when a FastAPI backend is generated.');
    }

    if (!backendText.includes('uvicorn')) {
      findings.push('Backend dependency manifest should include Uvicorn when a FastAPI backend is generated.');
    }

    if (!backendText.includes('pytest')) {
      findings.push('Backend dependency manifest should include pytest for smoke/API tests.');
    }

    const backendFiles = output.files.filter((file) => /\.py$/i.test(file.path) && /fastapi|@app\.get|APIRouter/i.test(file.content));
    if (!backendFiles.some((file) => /CORSMiddleware|allow_origins/i.test(file.content)) && hasFrontend) {
      findings.push('Backend should configure CORS for the generated frontend origin.');
    }

    if (!backendFiles.some((file) => /\/health|health_check|healthcheck/i.test(file.content))) {
      findings.push('Backend should expose a health endpoint such as GET /health.');
    }

    if (!hasDockerfileNear(dockerfiles, '.', /python|pip|uvicorn|fastapi/i) && !dockerfiles.some((file) => /python|pip|uvicorn|fastapi/i.test(file.content))) {
      findings.push('Backend should have a Dockerfile or container build file when containers are in scope.');
    }

    if (!hasTestFile(output, /fastapi|health|database|api|pytest/i)) {
      findings.push('Generated backend should include at least one pytest smoke test for health/database connectivity.');
    }
  }

  if (hasDatabase && !output.files.some((file) => /DATABASE_URL|DB_HOST|DB_PORT|DB_NAME|POSTGRES_|MYSQL_|MARIADB_|MONGO_/i.test(file.content))) {
    findings.push('Backend should connect to the database through environment variables.');
  }

  if (hasOwnedDatabase) {
    const hasSchemaOrMigration = output.files.some((file) => /create table|alembic|sqlmodel\.metadata\.create_all|prisma migrate|typeorm migration|sequelize migration|migration|schema/i.test(file.content) || /(^|\/)(migrations?|schema|initdb|database|db)\//i.test(normalizePath(file.path)));
    if (!hasSchemaOrMigration) {
      findings.push('Project-owned databases should include migrations, schema initialization, or an explicit database init script.');
    }

    if (!output.files.some((file) => /seed|sample data|insert into|fixtures?/i.test(file.content) || /seed|fixtures?|sample-data/i.test(file.path))) {
      findings.push('Project-owned databases should include safe seed data for local testing when the UI/API needs data.');
    }
  }

  if (hasExternalDatabase && output.files.some((file) => /(^|\/)(initdb|seed|fixtures?|sample-data)\//i.test(normalizePath(file.path)))) {
    findings.push('External/pre-existing databases should not include destructive local init or seed scripts unless explicitly requested.');
  }

  if (hasFrontend && hasBackend && !/8000|api base|api_base|NEXT_PUBLIC_API|VITE_API|PUBLIC_API/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should explain the backend API port and frontend API base URL.');
  }

  if (compose && !/docker compose up --build|docker-compose up --build|nerdctl compose up --build/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should include a Compose up/build command because a Compose file was generated.');
  }

  if (hasDatabase && !/DATABASE_URL|DB_HOST|DB_PORT|DB_NAME|connection string/i.test(output.setupInstructions)) {
    findings.push('Setup instructions should document required database environment variables or connection string.');
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
