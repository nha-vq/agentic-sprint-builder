import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(filePath, needle, message) {
  const content = read(filePath);
  if (!content.includes(needle)) {
    throw new Error(`${message}\nMissing in ${filePath}: ${needle}`);
  }
}

function assertMatches(filePath, pattern, message) {
  const content = read(filePath);
  if (!pattern.test(content)) {
    throw new Error(`${message}\nPattern not found in ${filePath}: ${pattern}`);
  }
}

function assertPathExists(relativePath, message) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`${message}\nMissing path: ${relativePath}`);
  }
}

for (const folder of ['.github/rules', '.github/skills']) {
  assertPathExists(folder, `Taskflow-style .github folder must exist: ${folder}`);
}

const requiredBaSections = [
  'Business Requirements',
  'Technical Requirements',
  'Features',
  'Selected Technology Stack',
  'Architecture Decisions',
  'Database Needs',
  'Authentication Needs',
  'API Architecture',
  'Frontend Needs',
  'Backend Needs',
  'Deployment Runtime Requirements',
  'Implementation Plan',
  'Acceptance Criteria'
];

for (const section of requiredBaSections) {
  assertIncludes('.github/skills/ba/SKILL.md', section, `BA skill must require structured ${section} output.`);
}

assertIncludes('lib/skills/project-dev-skill.ts', 'writeProjectDevSkill', 'TA DEV context writer must exist.');
assertIncludes('lib/skills/project-dev-skill.ts', 'loadProjectDevSkill', 'TA DEV context loader must exist.');
assertIncludes('lib/skills/project-dev-skill.ts', 'project-skills', 'TA DEV context must be saved under project-skills/.');
assertIncludes('lib/skills/project-dev-skill.ts', 'ta-dev-context.md', 'TA DEV context must be written separately from the static DEV skill.');
assertIncludes('lib/skills/project-dev-skill.ts', 'dev.md', 'TA DEV context loader must keep legacy dev.md fallback support.');
assertIncludes('lib/skills/project-dev-skill.ts', 'project-dev-template.md', 'TA DEV context writer must load a markdown template.');
assertIncludes('lib/skills/project-dev-skill.ts', 'TA_LEARNING_MEMORY', 'TA DEV context must persist accumulated lessons.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Prepare Tech Stack Skill', 'prepare-tech-stack skill must exist.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'frontend framework', 'prepare-tech-stack skill must decide frontend framework.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'backend framework', 'prepare-tech-stack skill must decide backend framework.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Docker strategy', 'prepare-tech-stack skill must decide Docker strategy.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Actual Tech Stack', 'Generated project skill template must record tech stack.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Future Feature Rules', 'Generated TA context template must include future feature rules.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', 'Requirement Context', 'Generated TA context template must reuse requirement-context flow.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', 'Task Context', 'Generated TA context template must reuse task-context flow.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Prepared Tech Stack', 'Generated TA context template must include prepared tech stack.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## TA Learning Memory', 'Generated TA context template must include learning memory.');

assertIncludes('lib/agents/base-agent.ts', 'systemAppend', 'Base agent must support appended TA DEV context.');
assertIncludes('lib/agents/tech-stack-agent.ts', 'runPrepareTechStackAgent', 'Tech stack agent runner must exist.');
assertIncludes('lib/types.ts', "'tech-stack'", 'AgentId must include tech-stack.');
assertIncludes('lib/agents/dev-agent.ts', 'projectDevSkill', 'DEV agent must accept TA DEV context.');
assertIncludes('lib/agents/dev-agent.ts', 'buildDevSystemAppend', 'DEV OpenRouter calls must append project/prepared TA context.');
assertIncludes('lib/agents/dev-agent.ts', 'PREPARED TECH STACK', 'DEV context must include prepared tech stack.');
assertIncludes('lib/agents/dev-agent.ts', 'filterNonLlmGeneratedManifestFiles', 'DEV agent must remove prepared/binary asset paths from LLM file-generation batches.');
assertIncludes('lib/agents/dev-agent.ts', 'prepared-media pipeline writes those files automatically', 'DEV manifest prompt must prevent planning prepared media files for LLM generation.');
assertIncludes('lib/validation/generated-execution.ts', 'validateFrontendRuntimeSmoke', 'Execution validation must verify visible frontend runtime behavior, not only HTTP 200.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBrowserRenderedPage', 'Execution validation must verify browser-rendered hydrated UI behavior.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBackendCorsForFrontendOrigins', 'Execution validation must verify backend CORS for generated frontend origins.');
assertIncludes('lib/validation/generated-execution.ts', 'VALIDATE_GENERATED_BROWSER', 'Browser validation must be configurable.');
assertIncludes('lib/validation/generated-execution.ts', 'picsum\\.photos', 'Browser validation must reject generic placeholder imagery for mockup-driven generated pages.');
assertIncludes('lib/validation/generated-execution.ts', 'validateNextImageUrls', 'Execution validation must verify rendered Next.js image optimizer URLs.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBackendProductApi', 'Execution validation must verify product API smoke when generated product routes exist.');
assertIncludes('lib/validation/generated-execution.ts', 'validateRuntimeLogs', 'Execution validation must scan Compose logs for generated runtime failures.');
assertIncludes('lib/validation/generated-execution.ts', 'extractDiagnosticHighlights', 'Execution validation diagnostics must preserve high-signal app failure lines.');
assertIncludes('lib/validation/generated-execution.ts', 'backendHealthUrls', 'Execution validation must support both /health and /api/health backend health endpoints.');
assertIncludes('lib/validation/generated-execution.ts', 'productNavigation', 'Browser validation must exercise product-card navigation, not only direct detail URLs.');
assertIncludes('lib/validation/generated-execution.ts', 'galleryInteraction', 'Browser validation must exercise product detail thumbnail gallery interaction.');
assertIncludes('lib/validation/generated-execution.ts', 'firstBackendProductDetailPath', 'Execution validation must derive concrete product detail URLs from backend data when server HTML has no product links.');
assertIncludes('lib/validation/generated-execution.ts', 'referencedGeneratedImageAssetSummary', 'Execution validation must allow valid referenced local image assets as a prepared-media fallback.');
assertIncludes('lib/validation/generated-execution.ts', 'hasUsableRenderedMedia', 'Browser validation must not fail prepared-media usage when decoded non-placeholder product media is rendered.');
assertIncludes('lib/validation/generated-execution.ts', 'GENERATED_BROWSER_VALIDATION_ATTEMPTS', 'Browser validation must retry transient headless/CDP failures before marking generated code broken.');
assertIncludes('lib/validation/generated-execution.ts', 'browser-error-attempt', 'Browser validation must persist per-attempt diagnostics when headless/CDP validation is flaky.');
assertMatches(
  'lib/validation/generated-execution.ts',
  /function extractFirstProductDetailPath\(html: string\)[\s\S]*return match\?\.\[1\] \?\? null;/,
  'Execution validation must not fall back to hardcoded /products/1 when hydrated React HTML has no product links.'
);
assertMatches(
  'lib/validation/generated-execution.ts',
  /const detailPath = extractFirstProductDetailPath\(home\.body\) \?\? \(await firstBackendProductDetailPath\(signal\)\);/,
  'Execution validation must fetch a concrete product detail route from backend product data when HTML links are unavailable.'
);
assertMatches(
  'lib/validation/generated-execution.ts',
  /if \(!containsAnyTextReference\(domSearchText, options\.preparedAssetReferences\) && !hasUsableRenderedMedia\(domEvidence\)\)/,
  'Browser validation must allow decoded non-placeholder product images as a prepared-media fallback.'
);
assertMatches(
  'lib/validation/generated-execution.ts',
  /images: images\.slice\(0, 20\)/,
  'Browser evidence must include rendered image metadata so prepared-media fallback checks are evidence-based.'
);
assertMatches(
  'lib/validation/generated-execution.ts',
  /for \(let attempt = 1; attempt <= attempts; attempt \+= 1\)[\s\S]*artifactName: attempt === 1 \? artifactName : `\$\{artifactName\}-attempt-\$\{attempt\}`/,
  'Browser validation must retry with separate evidence artifacts instead of failing on the first transient CDP/browser error.'
);
assertMatches(
  'lib/validation/generated-execution.ts',
  /const localMedia = await referencedGeneratedImageAssetSummary\(codeDir, \{ excludePreparedMedia: true \}\);[\s\S]*localMedia\.referenced\.length > 0 && localMedia\.invalid\.length === 0/,
  'Prepared-media source validation must pass when the generated project uses valid referenced local image assets instead.'
);
assertIncludes('lib/validation/generated-project.ts', 'JSX event handler prop such as onClick/onSubmit/onChange', 'Static readiness must catch App Router Server Component event handlers before deployment.');
assertIncludes('lib/validation/generated-project.ts', 'findGeneratedProductContractIssues', 'Static readiness must catch product API/list/detail contract mismatches before CodeReview and deploy.');
assertIncludes('lib/validation/generated-project.ts', 'findSpringDuplicateRouteIssues', 'Static readiness must catch duplicate Spring route mappings before Docker startup.');
assertIncludes('lib/validation/generated-project.ts', 'runs npm ci, but no generated package-lock.json', 'Static readiness must catch npm ci Dockerfiles without generated lockfiles before Docker build.');
assertIncludes('lib/validation/generated-project.ts', 'Generated npm lockfile', 'Static readiness must catch empty, invalid, or out-of-sync npm lockfiles before Docker/Next builds.');
assertIncludes('lib/validation/generated-project.ts', 'findPathAliasImportIssues', 'Static readiness must catch unresolved @/ frontend path aliases before Next builds.');
assertIncludes('lib/validation/generated-project.ts', 'return parseJsonObject(content) ?? parseJsonObject(stripJsonComments(content))', 'Static readiness JSONC parsing must not corrupt valid @/* path alias keys before parsing.');
assertIncludes('lib/validation/generated-project.ts', 'findNamedImportExportIssues', 'Static readiness must catch named imports that are not exported by generated local files.');
assertIncludes('lib/validation/generated-project.ts', 'findPythonContainerEntrypointIssues', 'Static readiness must catch Python container entrypoints that do not match the Docker build context.');
assertIncludes('lib/validation/generated-project.ts', 'findPythonFlatBackendImportIssues', 'Static readiness must catch flat Python backend imports that do not match the Docker build context.');
assertIncludes('lib/validation/generated-project.ts', 'Python flat backend import', 'Static readiness must classify flat Python backend import mismatches as deterministic blockers.');
assertIncludes('lib/validation/generated-project.ts', 'composeFiles', 'Static readiness seed startup detection must include root Compose commands, not only backend files.');
assertIncludes('lib/validation/generated-project.ts', 'findNextServerFetchBuildIssues', 'Static readiness must catch Next.js server fetches that would prerender against Compose-only DNS during next build.');
assertIncludes('lib/validation/generated-project.ts', 'App Router server data fetch', 'Static readiness must classify Next.js server-fetch prerender failures as deterministic blockers.');
assertIncludes('lib/validation/generated-project.ts', 'startup files do not invoke', 'Static readiness must catch generated product seed files that are not invoked by backend startup.');
assertIncludes('lib/validation/generated-project.ts', 'Missing frontend dependency', 'Static readiness must catch Tailwind/PostCSS/autoprefixer config references missing from package.json.');
assertIncludes('lib/validation/generated-project.ts', 'findPreparedStackImplementationIssues', 'Static readiness must catch generated implementation stacks that disagree with prepared tech stack.');
assertIncludes('lib/validation/generated-project.ts', 'generated frontend/package.json uses react-scripts/Create React App', 'Static readiness must catch CRA output when prepared tech stack selected Next.js.');
assertIncludes('lib/validation/generated-project.ts', 'generated backend files contain Spring Boot/Maven implementation signals', 'Static readiness must catch Spring Boot output when prepared tech stack selected FastAPI.');
assertIncludes('lib/validation/generated-project.ts', 'POSTGRES_IMPLEMENTATION_PATTERN', 'Static readiness must catch service database output when prepared tech stack selected file-based persistence.');
assertIncludes('lib/validation/generated-project.ts', 'Do not keep a service database when the current tech spec selected file-based persistence', 'Static readiness must catch conflicting database service output when prepared tech stack selected file-based persistence.');
assertIncludes('lib/validation/generated-project.ts', 'deterministicStaticBlockerFindings', 'Static readiness must classify deterministic blockers for cost-controlled orchestration gates.');
assertIncludes('lib/orchestrator.ts', 'pre-review static contract validation gate', 'Orchestrator must run deterministic static contract validation before paid CodeReview/DevOps loops.');
assertIncludes('lib/orchestrator.ts', 'skipPaidValidationForStaticBlockers', 'Orchestrator must skip paid review/deploy loops when deterministic static blockers remain after bounded repair.');
assertIncludes('lib/orchestrator.ts', 'createStaticBlockedExecutionValidation', 'Orchestrator must record a deterministic execution failure instead of spending execution-repair calls on known static blockers.');
assertIncludes('lib/orchestrator.ts', 'Skipped paid CodeReview/DevOps validation and execution repair', 'Cost-control notes must explain when deterministic static blockers stop paid validation loops.');
assertMatches(
  'lib/orchestrator.ts',
  /while \(buildReadiness\.status === 'NEEDS_FIX' && !skipPaidValidationForStaticBlockers && buildReadinessFixIterations < MAX_BUILD_READINESS_FIX_ITERATIONS\)/,
  'Static readiness must not spend a second repair loop after pre-review static blockers already gated paid validation.'
);
assertIncludes('lib/validation/repair-scope.ts', 'route-contract failures', 'Repair scope must route API 404 and double-prefix failures to Backend DEV ownership.');
assertIncludes('lib/validation/repair-scope.ts', 'For path alias failures, generate valid JSON', 'Repair scope must route static path alias failures to frontend/config repair guidance.');
assertIncludes('lib/validation/repair-scope.ts', 'imports .+ but no matching generated file', 'Repair scope must route unresolved local import failures to frontend repair guidance.');
assertIncludes('lib/validation/repair-scope.ts', 'frontend/src/app/products/[id]/page.tsx must use ../../../lib/api', 'Repair scope must explain relative import depth for generated Next.js detail routes.');
assertIncludes('lib/validation/repair-scope.ts', 'name.endsWith(\'.sh\')', 'Docker repair scope must include generated startup scripts such as start.sh.');
assertIncludes('lib/validation/repair-scope.ts', 'main:app, not backend.main:app', 'Docker repair scope must explain FastAPI Uvicorn module paths for flat backend contexts.');
assertIncludes('lib/validation/repair-scope.ts', 'from .models', 'Docker repair scope must explain that flat Python backend files cannot use package-relative imports.');
assertIncludes('lib/validation/repair-scope.ts', 'README-only seed instructions do not satisfy runtime validation', 'Docker repair scope must reject README-only seed setup for generated product apps.');
assertIncludes('lib/validation/repair-scope.ts', "export const dynamic = 'force-dynamic'", 'Repair scope must route Next.js prerender backend DNS failures to frontend dynamic/no-store fixes.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Do not put JSX event props', 'Frontend DEV skill must block App Router Server Component event handlers.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Server Component rule', 'TA skill must pass App Router Server Component constraints to DEV.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'never generate empty or placeholder lockfiles', 'TA skill must pass npm lockfile repair guidance to DEV.');
assertIncludes('.github/skills/tech-stack/SKILL.md', '`@/` imports require a generated `tsconfig.json` or `jsconfig.json`', 'TA skill must pass path alias guidance to DEV.');
assertPathExists('lib/media/prepared-assets.ts', 'Prepared local media asset pipeline must exist.');
assertIncludes('lib/media/prepared-assets.ts', 'prepareMediaAssets', 'Prepared media pipeline must download safe image candidates.');
assertIncludes('lib/media/prepared-assets.ts', 'writePreparedMediaAssets', 'Prepared media pipeline must write local public assets.');
assertIncludes('lib/media/prepared-assets.ts', 'formatPreparedMediaAssetsForPrompt', 'Prepared media pipeline must expose local asset URLs to DEV prompts.');
assertIncludes('lib/orchestrator.ts', 'prepareMediaAssets', 'Orchestrator must prepare local media assets before DEV implementation.');
assertIncludes('lib/orchestrator.ts', 'writePreparedMediaAssets', 'Orchestrator must persist prepared local media assets into generated-code.');
assertIncludes('lib/agents/dev-agent.ts', 'PREPARED LOCAL MEDIA ASSETS', 'DEV context must include prepared local media assets.');
assertIncludes('lib/validation/generated-execution.ts', 'media-manifest.json', 'Execution validation must read prepared local media manifest.');
assertIncludes('lib/validation/generated-execution.ts', 'validatePreparedMediaAssetUsage', 'Execution validation must fail when generated source ignores prepared media assets.');
assertIncludes('lib/validation/generated-execution.ts', 'browser DOM does not use prepared local media assets', 'Browser validation must fail when hydrated UI ignores prepared media assets.');
assertIncludes('lib/validation/generated-execution.ts', "failedSteps.length > 0 ? 'NEEDS_FIX'", 'Execution validation failures must take precedence over infrastructure skip classification.');
assertIncludes('lib/openrouter.ts', 'LLM_MAX_RETRIES', 'OpenRouter adapter must support configurable retry count.');
assertIncludes('lib/openrouter.ts', 'OPENROUTER_REQUEST_TIMEOUT_MS', 'OpenRouter adapter must timeout stalled provider calls so runs do not block indefinitely.');
assertIncludes('lib/openrouter.ts', 'OpenRouterEmptyContentError', 'OpenRouter empty-content responses must be typed as retryable.');
assertIncludes('lib/agents/ux-agent.ts', 'UX_AGENT_FALLBACK_MODEL', 'UX agent must support fallback model configuration.');
assertIncludes('lib/agents/ux-agent.ts', 'createDegradedUXContract', 'UX agent must support degraded fallback contract generation.');
assertIncludes('lib/storage/file-writer.ts', 'saveFailedRunSnapshot', 'Failed async runs must persist diagnostic artifacts.');
assertIncludes('lib/storage/file-writer.ts', "'.sh'", 'Generated-code snapshots must include startup shell scripts such as backend/start.sh for static validation and repair context.');
assertIncludes('app/api/runs/route.ts', 'saveFailedRunSnapshot', 'Run API must persist failed async run snapshots.');
assertIncludes('lib/dashboard.ts', 'dashboardError', 'Dashboard event emission must preserve rejection diagnostics.');
assertIncludes('lib/dashboard.ts', 'validateDashboardReadiness', 'Dashboard identity preflight must validate company and agent ids before a run.');
assertIncludes('lib/dashboard.ts', 'checkDashboardConnectivity', 'Dashboard preflight must detect unreachable dashboard API/DNS before a run.');
assertIncludes('lib/dashboard.ts', 'DASHBOARD_OPTIONAL', 'Dashboard must be optional by default and not block AI runs.');
assertIncludes('lib/orchestrator.ts', 'Dashboard is optional', 'Orchestrator must treat dashboard as optional preflight.');
assertIncludes('lib/orchestrator.ts', "stepStatus: 'SKIPPED'", 'Unavailable optional dashboard must be marked skipped, not fail.');
assertIncludes('app/api/dashboard/status/route.ts', 'getDashboardIdentitySnapshotWithConnectivity', 'Dashboard status API must expose connectivity diagnostics.');
assertPathExists('app/api/dashboard/event-test/route.ts', 'Dashboard event diagnostic API must exist so event acceptance can be tested without a paid run.');
assertIncludes('app/page.tsx', 'Test Dashboard Event', 'Dashboard UI must expose a cheap event diagnostic button.');
assertIncludes('app/page.tsx', 'Dashboard events:', 'Run result UI must show dashboard event acceptance summary.');
assertIncludes('app/page.tsx', 'Prepared Media Assets', 'Run result UI must show prepared media assets.');
assertIncludes('app/runs/[runId]/page.tsx', 'Prepared Media Assets', 'Saved run output UI must show prepared media assets.');
assertIncludes('.env.example', 'MEDIA_ASSET_LIMIT=4', 'Example env must expose prepared media asset limit.');
assertIncludes('.env.example', 'MEDIA_ASSET_DOWNLOAD_TIMEOUT_MS=12000', 'Example env must expose prepared media download timeout.');
assertIncludes('.github/skills/dev/SKILL.md', 'API_INTERNAL_URL=http://backend:8000', 'DEV skill must require separate internal backend URL for server-rendered frontend code.');
assertIncludes('.github/skills/dev/SKILL.md', '/assets/generated-media/', 'DEV skill must require prepared local media asset usage.');
assertIncludes('.github/skills/dev/SKILL.md', 'Do not double-prefix routes', 'DEV skill must explicitly prevent backend route double-prefix mistakes.');
assertIncludes('.github/skills/dev/SKILL.md', 'prefer the canonical backend API paths `GET /api/products`', 'DEV skill must require canonical generated product API routes.');
assertIncludes('.github/skills/dev/SKILL.md', 'the target module must explicitly export that exact symbol', 'DEV skill must prevent frontend pages from importing missing local named exports.');
assertIncludes('.github/skills/dev/SKILL.md', 'backend.main:app', 'DEV skill must prevent flat backend Docker contexts from starting nonexistent backend packages.');
assertIncludes('.github/skills/dev/SKILL.md', 'from .models', 'DEV skill must prevent package-relative imports in flat backend Docker contexts.');
assertIncludes('.github/skills/dev/SKILL.md', 'README-only seed instructions do not satisfy runtime validation', 'DEV skill must prevent README-only seeding for generated product apps.');
assertIncludes('.github/skills/dev/SKILL.md', "export const dynamic = 'force-dynamic'", 'DEV skill must prevent Next.js build-time prerender fetches against Compose-only backend DNS.');
assertIncludes('.github/skills/dev/SKILL.md', 'backend startup path must invoke it', 'DEV skill must require generated product seed files to run at backend startup.');
assertIncludes('.github/skills/dev/SKILL.md', 'Never generate an empty or placeholder `package-lock.json`', 'DEV skill must prevent placeholder npm lockfiles.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'must not accidentally expose `/api/products/products`', 'Backend DEV skill must prevent product route double-prefix mistakes.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'expose canonical collection/detail API routes at `GET /api/products`', 'Backend DEV skill must require canonical generated product API routes.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'uvicorn main:app', 'Backend DEV skill must align FastAPI startup with flat backend Docker contexts.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'from .models', 'Backend DEV skill must prevent package-relative imports in flat backend Docker contexts.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'README-only seed commands do not satisfy runtime validation', 'Backend DEV skill must prevent README-only seeding for generated product apps.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'backend startup must invoke it', 'Backend DEV skill must require generated seed files to run at startup.');
assertIncludes('.github/skills/backend-dev/SKILL.md', 'Do not define the same HTTP method and path in more than one controller', 'Backend DEV skill must prevent duplicate controller route mappings.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'Frontend/backend route-contract mismatches are integration blockers', 'Integration DEV skill must verify exact API paths before deploy.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'Do not run `npm ci` unless a matching generated', 'Integration DEV skill must prevent npm ci without generated lockfiles.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'Never add an empty or placeholder lockfile', 'Integration DEV skill must prevent placeholder lockfiles during Docker repairs.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'If frontend source uses `@/` imports', 'Integration DEV skill must verify path alias config before deploy.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'Use `uvicorn main:app` when `backend/main.py` is copied to `/app/main.py`', 'Integration DEV skill must align FastAPI startup with Docker build context.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'from .models', 'Integration DEV skill must prevent package-relative imports in flat backend Docker contexts.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'README-only seed instructions are not enough', 'Integration DEV skill must prevent README-only seeding for generated product apps.');
assertIncludes('.github/skills/integration-dev/SKILL.md', 'before Compose DNS exists', 'Integration DEV skill must prevent Next.js build-time prerender fetches against Compose-only backend DNS.');
assertIncludes('.github/skills/code-review/SKILL.md', '`/api/products/products` caused by double prefixing is blocking', 'Code Review skill must block exact route-contract mismatches.');
assertIncludes('.github/skills/code-review/SKILL.md', 'must not run `npm ci` unless a matching generated lockfile exists', 'Code Review skill must block npm ci without generated lockfiles.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Empty, invalid, or out-of-sync `package-lock.json` files are blocking', 'Code Review skill must block malformed npm lockfiles.');
assertIncludes('.github/skills/code-review/SKILL.md', '`@/` imports resolve through a generated `tsconfig.json` or `jsconfig.json`', 'Code Review skill must block unresolved path alias imports.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Named imports from generated local modules must match actual exports', 'Code Review skill must block missing local named exports.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Bare `/products` routes are blocking when the validation contract expects `/api/products`', 'Code Review skill must block bare product routes when canonical /api routes are required.');
assertIncludes('.github/skills/code-review/SKILL.md', 'uvicorn main:app', 'Code Review skill must catch FastAPI entrypoints that do not match Docker build context.');
assertIncludes('.github/skills/code-review/SKILL.md', 'from .models', 'Code Review skill must catch package-relative imports in flat backend Docker contexts.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Do not mark idempotent startup seeding as blocking', 'Code Review skill must allow idempotent startup seeding when product seed files must be invoked.');
assertIncludes('.github/skills/code-review/SKILL.md', 'before Compose DNS exists', 'Code Review skill must catch Next.js build-time prerender fetches against Compose-only backend DNS.');
assertIncludes('.github/skills/code-review/SKILL.md', 'verify they are invoked by backend startup', 'Code Review skill must catch generated seed files that are not invoked.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Using equivalent Tailwind utilities or CSS instead of named custom Tailwind token classes is advisory', 'Code Review skill must not block on style-token implementation preferences without a concrete visual mismatch.');
assertIncludes('lib/agents/code-review-agent.ts', 'Do not mark implementation-style preferences as blocking', 'CodeReview prompt must keep style-token implementation preferences advisory unless a concrete mismatch exists.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Server-side frontend code running inside Docker must not call `localhost`', 'Frontend DEV skill must prevent Docker SSR localhost backend calls.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'that module must export the exact symbol', 'Frontend DEV skill must prevent pages from importing missing local named exports.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Do not use imports such as `@/components/...`', 'Frontend DEV skill must prevent @/ imports without path alias config.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'If frontend config or source references Tailwind, PostCSS, or `autoprefixer`', 'Frontend DEV skill must include build tool dependencies referenced by config.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'must not prerender against Compose-only DNS', 'Frontend DEV skill must prevent Next.js build-time prerender fetches against Compose-only backend DNS.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Do not use generic placeholder image services', 'Frontend DEV skill must reject generic placeholder imagery for mockup-driven pages.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', '/assets/generated-media/', 'Frontend DEV skill must require prepared local media asset usage.');
assertIncludes('.github/skills/code-review/SKILL.md', '/_next/image` returning 400 is blocking', 'Code Review skill must block broken rendered Next.js images.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Mockup-driven product/media imagery must not use generic placeholder image services', 'Code Review skill must block generic placeholder imagery.');
assertIncludes('.github/skills/deploy/SKILL.md', 'from .models', 'Deploy skill must catch package-relative imports in flat backend Docker contexts.');
assertIncludes('.github/skills/deploy/SKILL.md', 'Do not reject idempotent startup seeding', 'Deploy skill must allow idempotent startup seeding when product seed files must be invoked.');
assertIncludes('.github/skills/deploy/SKILL.md', 'ENOTFOUND backend', 'Deploy skill must catch Next.js build-time prerender fetches against Compose-only backend DNS.');
assertIncludes('.github/skills/code-review/SKILL.md', '/assets/generated-media/', 'Code Review skill must check prepared local media asset usage.');
assertIncludes('.github/skills/qa/SKILL.md', 'Do not pass based only on backend health and frontend HTTP 200', 'QA skill must require visible route/data/image validation.');
assertIncludes('.github/skills/qa/SKILL.md', 'generic placeholder image services', 'QA skill must block placeholder image services when mockups exist.');
assertIncludes('.github/skills/qa/SKILL.md', 'PASS requires concrete evidence', 'QA skill must require concrete browser/runtime evidence before passing.');
assertIncludes('.github/skills/qa/SKILL.md', '/assets/generated-media/', 'QA skill must fail runs that ignore prepared local media assets.');
assertIncludes('.github/skills/deploy/SKILL.md', 'missing, empty, invalid, or out-of-sync lockfile', 'Deploy skill must reject npm ci with malformed lockfiles.');
assertIncludes('.github/skills/deploy/SKILL.md', 'unresolved `@/` imports', 'Deploy skill must route unresolved path alias build failures back to DEV.');
assertIncludes('.github/skills/deploy/SKILL.md', 'uvicorn main:app', 'Deploy skill must catch FastAPI entrypoints that do not match Docker build context.');
assertIncludes('.github/skills/deploy/SKILL.md', 'backend startup must invoke them', 'Deploy skill must catch generated seed files that are not invoked.');
assertIncludes('lib/agents/qa-agent.ts', 'enforceExecutionValidationGate', 'QA runner must not allow PASS when automated execution validation failed.');
assertIncludes('lib/agents/qa-agent.ts', 'requirementImages', 'QA agent must receive requirement images for visual fidelity review.');
assertIncludes('lib/agents/qa-agent.ts', 'components|pages|src', 'QA agent must include frontend visual files in review excerpts.');
assertIncludes('lib/orchestrator.ts', 'RUN_COST_BUDGET_USD', 'Orchestrator must enforce a configurable run cost budget.');
assertIncludes('lib/orchestrator.ts', 'stopForCostBudget', 'Orchestrator must stop optional repair/model-review loops when the cost budget is reached.');
assertIncludes('lib/orchestrator.ts', "RUN_FULL_QA_AGENT || 'auto'", 'Full QA model review must support auto mode for cost control.');
assertIncludes('lib/types.ts', 'costControlNotes', 'Run result must preserve cost-control decisions.');
assertIncludes('app/page.tsx', 'Cost Controls', 'Run result UI must show cost-control decisions.');
assertIncludes('.env.example', 'RUN_COST_BUDGET_USD=10', 'Example env must define a run cost budget.');
assertIncludes('.env.example', 'RUN_FULL_QA_AGENT=auto', 'Example env must default QA to auto cost-control mode.');
assertPathExists('lib/specs/project-specs.ts', 'Spec-driven contract builder must exist.');
assertIncludes('lib/types.ts', 'ProjectSpecArtifact', 'Run result must define spec-driven artifacts.');
assertIncludes('lib/orchestrator.ts', 'buildPreDevSpecArtifacts', 'Orchestrator must prepare specs before DEV runs.');
assertIncludes('lib/orchestrator.ts', 'buildFinalSpecArtifacts', 'Orchestrator must finalize specs before saving runs.');
assertIncludes('lib/agents/dev-agent.ts', 'SPEC-DRIVEN CONTRACT', 'DEV prompts must include the spec-driven contract.');
assertIncludes('lib/agents/qa-agent.ts', 'SPEC-DRIVEN CONTRACT', 'QA prompts must include the spec-driven contract.');
assertIncludes('app/page.tsx', 'Spec-Driven Contracts', 'Run result UI must show spec-driven artifacts.');
assertPathExists('lib/reports/observation-report.ts', 'Automatic observation report generator must exist.');
assertIncludes('lib/reports/observation-report.ts', 'generateObservationReport', 'Observation report generator must expose a run report function.');
assertIncludes('lib/reports/observation-report.ts', 'VisualComparisonResult', 'Observation report must produce visual comparison evidence.');
assertIncludes('lib/orchestrator.ts', 'generateObservationReport', 'Orchestrator must generate an observation report after every run.');
assertPathExists('app/api/reports/[...path]/route.ts', 'Report API route must expose generated observation reports and assets.');
assertIncludes('lib/types.ts', 'visualComparison', 'Run result must preserve visual comparison results.');
assertIncludes('app/page.tsx', 'Open observation report', 'Run result UI must link to observation report.');
assertIncludes('app/runs/[runId]/page.tsx', 'Visual Comparison', 'Saved run output UI must show visual comparison results.');

assertIncludes('lib/orchestrator.ts', 'loadProjectDevSkill', 'Orchestrator must load TA DEV context.');
assertIncludes('lib/orchestrator.ts', 'writeProjectDevSkill', 'Orchestrator must write/update TA DEV context.');
assertIncludes('lib/orchestrator.ts', 'runPrepareTechStackAgent', 'Orchestrator must run prepare-tech-stack.');
assertIncludes('lib/orchestrator.ts', 'MAX_TECH_STACK_FIX_ITERATIONS', 'Orchestrator must retry invalid prepared tech stack output before spending DEV calls.');
assertIncludes('lib/orchestrator.ts', 'validatePreparedTechStackAlignment', 'Orchestrator must gate DEV generation on explicit tech-spec stack alignment.');
assertIncludes('lib/orchestrator.ts', 'prepare-tech-stack output does not satisfy the explicit stack contract', 'Orchestrator must stop before DEV generation when TA cannot satisfy explicit stack requirements.');
assertIncludes('lib/agents/tech-stack-agent.ts', 'validationFeedback', 'prepare-tech-stack agent must accept validation feedback for a focused retry.');
assertIncludes('lib/agents/tech-stack-agent.ts', 'Existing generated-code history is context, not permission to keep a conflicting stack', 'prepare-tech-stack prompt must not preserve old generated-code stack over explicit current tech spec.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'must not silently override explicit stack choices', 'prepare-tech-stack skill must prioritize explicit current stack choices over existing project memory.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'backend exposes `GET /api/products`', 'prepare-tech-stack skill must pass canonical product API contract guidance to DEV.');
assertIncludes('.env.example', 'MAX_TECH_STACK_FIX_ITERATIONS=1', 'Example env must expose bounded tech-stack contract repair retries.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', 'uvicorn main:app', 'Project DEV memory template must preserve FastAPI flat-backend Docker entrypoint lessons.');
assertIncludes('lib/orchestrator.ts', 'Create TA DEV context after first generated-code scaffold.', 'First scaffold must create TA DEV context.');
assertMatches('lib/orchestrator.ts', /runDevAgent\(\{[\s\S]*projectDevSkill/s, 'Orchestrator must pass TA DEV context to DEV agent.');

const orchestrator = read('lib/orchestrator.ts');
const baIndex = orchestrator.indexOf('const baOutput = await runBAAgent');
const techStackIndex = orchestrator.indexOf('let preparedTechStack');
const firstDevIndex = orchestrator.indexOf('let devOutput = await runDevAgent');
const firstProjectSkillUpdateIndex = orchestrator.indexOf('projectDevSkill = await updateProjectSkillFromDevOutput');
if (!(baIndex >= 0 && techStackIndex > baIndex && firstDevIndex > techStackIndex)) {
  throw new Error('Orchestrator must enforce BA -> prepare-tech-stack -> DEV order.');
}
if (!(firstProjectSkillUpdateIndex > techStackIndex)) {
  throw new Error('Orchestrator must not update TA DEV context before prepare-tech-stack completes.');
}

assertIncludes('lib/validation/agent-lifecycle.ts', 'validateBaOutputStructure', 'Lifecycle validation must validate BA structured output.');
assertIncludes('lib/validation/agent-lifecycle.ts', 'validatePreparedTechStackStructure', 'Lifecycle validation must validate prepare-tech-stack output.');
assertIncludes('lib/validation/agent-lifecycle.ts', 'validatePreparedTechStackAlignment', 'Lifecycle validation must verify prepared tech stack alignment with explicit user tech spec choices.');
assertIncludes('lib/validation/agent-lifecycle.ts', 'Existing generated code or run history must not override explicit stack choices', 'Tech-stack alignment findings must prevent old generated-code history from overriding current explicit stack input.');
assertIncludes('app/api/runs/route.ts', 'projectId', 'Run API must accept projectId for skill selection.');

assertIncludes('lib/agents/code-review-agent.ts', 'runCodeReviewAgent', 'CodeReview agent runner must exist.');
assertIncludes('lib/agents/deploy-agent.ts', 'runDeployAgent', 'Deploy agent runner must exist.');
assertIncludes('lib/orchestrator.ts', 'runCodeReviewAgent', 'Orchestrator must run CodeReview agent.');
assertIncludes('lib/orchestrator.ts', 'runDeployAgent', 'Orchestrator must run Deploy agent.');
assertIncludes('lib/orchestrator.ts', 'enrichSkillContext', 'Orchestrator must enrich skill context from tech stack.');
assertIncludes('lib/types.ts', "'code-review'", 'AgentId must include code-review.');
assertIncludes('lib/types.ts', "'deploy'", 'AgentId must include deploy.');

console.log('Project skill lifecycle validation passed.');
