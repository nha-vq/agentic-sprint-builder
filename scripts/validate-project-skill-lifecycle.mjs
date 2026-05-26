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
assertIncludes('lib/validation/generated-execution.ts', 'validateFrontendRuntimeSmoke', 'Execution validation must verify visible frontend runtime behavior, not only HTTP 200.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBrowserRenderedPage', 'Execution validation must verify browser-rendered hydrated UI behavior.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBackendCorsForFrontendOrigins', 'Execution validation must verify backend CORS for generated frontend origins.');
assertIncludes('lib/validation/generated-execution.ts', 'VALIDATE_GENERATED_BROWSER', 'Browser validation must be configurable.');
assertIncludes('lib/validation/generated-execution.ts', 'picsum\\.photos', 'Browser validation must reject generic placeholder imagery for mockup-driven generated pages.');
assertIncludes('lib/validation/generated-execution.ts', 'validateNextImageUrls', 'Execution validation must verify rendered Next.js image optimizer URLs.');
assertIncludes('lib/validation/generated-execution.ts', 'validateBackendProductApi', 'Execution validation must verify product API smoke when generated product routes exist.');
assertIncludes('lib/validation/generated-execution.ts', 'validateRuntimeLogs', 'Execution validation must scan Compose logs for generated runtime failures.');
assertIncludes('lib/validation/generated-project.ts', 'JSX event handler prop such as onClick/onSubmit/onChange', 'Static readiness must catch App Router Server Component event handlers before deployment.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Do not put JSX event props', 'Frontend DEV skill must block App Router Server Component event handlers.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Server Component rule', 'TA skill must pass App Router Server Component constraints to DEV.');
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
assertIncludes('lib/openrouter.ts', 'OpenRouterEmptyContentError', 'OpenRouter empty-content responses must be typed as retryable.');
assertIncludes('lib/agents/ux-agent.ts', 'UX_AGENT_FALLBACK_MODEL', 'UX agent must support fallback model configuration.');
assertIncludes('lib/agents/ux-agent.ts', 'createDegradedUXContract', 'UX agent must support degraded fallback contract generation.');
assertIncludes('lib/storage/file-writer.ts', 'saveFailedRunSnapshot', 'Failed async runs must persist diagnostic artifacts.');
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
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Server-side frontend code running inside Docker must not call `localhost`', 'Frontend DEV skill must prevent Docker SSR localhost backend calls.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', 'Do not use generic placeholder image services', 'Frontend DEV skill must reject generic placeholder imagery for mockup-driven pages.');
assertIncludes('.github/skills/frontend-dev/SKILL.md', '/assets/generated-media/', 'Frontend DEV skill must require prepared local media asset usage.');
assertIncludes('.github/skills/code-review/SKILL.md', '/_next/image` returning 400 is blocking', 'Code Review skill must block broken rendered Next.js images.');
assertIncludes('.github/skills/code-review/SKILL.md', 'Mockup-driven product/media imagery must not use generic placeholder image services', 'Code Review skill must block generic placeholder imagery.');
assertIncludes('.github/skills/code-review/SKILL.md', '/assets/generated-media/', 'Code Review skill must check prepared local media asset usage.');
assertIncludes('.github/skills/qa/SKILL.md', 'Do not pass based only on backend health and frontend HTTP 200', 'QA skill must require visible route/data/image validation.');
assertIncludes('.github/skills/qa/SKILL.md', 'generic placeholder image services', 'QA skill must block placeholder image services when mockups exist.');
assertIncludes('.github/skills/qa/SKILL.md', 'PASS requires concrete evidence', 'QA skill must require concrete browser/runtime evidence before passing.');
assertIncludes('.github/skills/qa/SKILL.md', '/assets/generated-media/', 'QA skill must fail runs that ignore prepared local media assets.');
assertIncludes('lib/agents/qa-agent.ts', 'enforceExecutionValidationGate', 'QA runner must not allow PASS when automated execution validation failed.');
assertIncludes('lib/agents/qa-agent.ts', 'requirementImages', 'QA agent must receive requirement images for visual fidelity review.');
assertIncludes('lib/agents/qa-agent.ts', 'components|pages|src', 'QA agent must include frontend visual files in review excerpts.');
assertIncludes('lib/orchestrator.ts', 'RUN_COST_BUDGET_USD', 'Orchestrator must enforce a configurable run cost budget.');
assertIncludes('lib/orchestrator.ts', 'stopForCostBudget', 'Orchestrator must stop optional repair/model-review loops when the cost budget is reached.');
assertIncludes('lib/orchestrator.ts', "RUN_FULL_QA_AGENT || 'auto'", 'Full QA model review must support auto mode for cost control.');
assertIncludes('lib/types.ts', 'costControlNotes', 'Run result must preserve cost-control decisions.');
assertIncludes('app/page.tsx', 'Cost Controls', 'Run result UI must show cost-control decisions.');
assertIncludes('.env.example', 'RUN_COST_BUDGET_USD=6', 'Example env must define a run cost budget.');
assertIncludes('.env.example', 'RUN_FULL_QA_AGENT=auto', 'Example env must default QA to auto cost-control mode.');
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
assertIncludes('lib/orchestrator.ts', 'Create TA DEV context after first generated-code scaffold.', 'First scaffold must create TA DEV context.');
assertMatches('lib/orchestrator.ts', /runDevAgent\(\{[\s\S]*projectDevSkill/s, 'Orchestrator must pass TA DEV context to DEV agent.');

const orchestrator = read('lib/orchestrator.ts');
const baIndex = orchestrator.indexOf('const baOutput = await runBAAgent');
const techStackIndex = orchestrator.indexOf('const preparedTechStack');
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
assertIncludes('app/api/runs/route.ts', 'projectId', 'Run API must accept projectId for skill selection.');

assertIncludes('lib/agents/code-review-agent.ts', 'runCodeReviewAgent', 'CodeReview agent runner must exist.');
assertIncludes('lib/agents/deploy-agent.ts', 'runDeployAgent', 'Deploy agent runner must exist.');
assertIncludes('lib/orchestrator.ts', 'runCodeReviewAgent', 'Orchestrator must run CodeReview agent.');
assertIncludes('lib/orchestrator.ts', 'runDeployAgent', 'Orchestrator must run Deploy agent.');
assertIncludes('lib/orchestrator.ts', 'enrichSkillContext', 'Orchestrator must enrich skill context from tech stack.');
assertIncludes('lib/types.ts', "'code-review'", 'AgentId must include code-review.');
assertIncludes('lib/types.ts', "'deploy'", 'AgentId must include deploy.');

console.log('Project skill lifecycle validation passed.');
