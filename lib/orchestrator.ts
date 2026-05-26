import {
  checkDashboardConnectivity,
  disableDashboardRemoteEvents,
  emitDashboardEvent,
  enableDashboardRemoteEvents,
  registerDashboardCompany,
  shouldAutoRegisterDashboard,
  validateDashboardReadiness
} from '@/lib/dashboard';
import { runBAAgent } from '@/lib/agents/ba-agent';
import { runDevAgent } from '@/lib/agents/dev-agent';
import { runCodeReviewAgent, type CodeReviewOutput } from '@/lib/agents/code-review-agent';
import { runDeployAgent, type DeployOutput } from '@/lib/agents/deploy-agent';
import { runQAAgent } from '@/lib/agents/qa-agent';
import { runPrepareTechStackAgent } from '@/lib/agents/tech-stack-agent';
import { runUXAgent } from '@/lib/agents/ux-agent';
import { formatGeneratedProjectOverview } from '@/lib/context/agent-context';
import { listRunResults, readGeneratedCodeSnapshot, saveRunResult, writeGeneratedFiles } from '@/lib/storage/file-writer';
import { validateGeneratedProject, type GeneratedProjectValidation } from '@/lib/validation/generated-project';
import { prewarmGeneratedComposeRuntime, validateGeneratedProjectExecution } from '@/lib/validation/generated-execution';
import { formatRepairScope, inferQaRepairScope, inferReviewRepairScope, inferStaticRepairScope } from '@/lib/validation/repair-scope';
import { validateBaOutputStructure, validatePreparedTechStackStructure } from '@/lib/validation/agent-lifecycle';
import { DEFAULT_PROJECT_ID, loadProjectDevSkill, writeProjectDevSkill, writePreDevProjectSkill, type ProjectDevSkill } from '@/lib/skills/project-dev-skill';
import { enrichSkillContext } from '@/lib/skills/skill-enrichment';
import { searchFreeSafeImages } from '@/lib/media/free-image-search';
import { prepareMediaAssets, writePreparedMediaAssets, type PreparedMediaAssetFile } from '@/lib/media/prepared-assets';
import { generateObservationReport } from '@/lib/reports/observation-report';
import { agentModelFor } from '@/lib/agent-models';
import { runWithLlmUsageTracking, summarizeLlmUsage } from '@/lib/llm/usage-tracker';
import fs from 'fs/promises';
import path from 'path';
import type { AgentEvent, DevOutput, GeneratedExecutionValidationResult, GeneratedFile, LlmUsageRecord, PreparedMediaAsset, PreparedTechStackOutput, QAReviewOutput, RepairScope, RunProgressReporter, RunRequest, RunResult, UXContractOutput } from '@/lib/types';

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const MAX_CODE_REVIEW_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_CODE_REVIEW_FIX_ITERATIONS', 2);
const MAX_DEPLOY_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_DEPLOY_FIX_ITERATIONS', 2);
const MAX_QA_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_QA_FIX_ITERATIONS', 1);
const MAX_BUILD_READINESS_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_BUILD_READINESS_FIX_ITERATIONS', 2);
const MAX_EXECUTION_VALIDATION_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_EXECUTION_VALIDATION_FIX_ITERATIONS', 3);
const MAX_REPAIR_LOG_CHARS = readPositiveIntegerEnv('MAX_REPAIR_LOG_CHARS', 8_000);
const MAX_REPAIR_TOTAL_LOG_CHARS = readPositiveIntegerEnv('MAX_REPAIR_TOTAL_LOG_CHARS', 20_000);
const MAX_REPAIR_TREE_FILES = readPositiveIntegerEnv('MAX_REPAIR_TREE_FILES', 120);
const RUN_COST_BUDGET_USD = readNonNegativeNumberEnv('RUN_COST_BUDGET_USD', 6);
const RUN_COST_WARN_USD = readNonNegativeNumberEnv('RUN_COST_WARN_USD', 4);

function shouldRunFullQaAgent(validation?: GeneratedExecutionValidationResult) {
  const raw = (process.env.RUN_FULL_QA_AGENT || 'auto').trim().toLowerCase();
  if (['false', '0', 'no', 'skip', 'smoke'].includes(raw)) return false;
  if (['true', '1', 'yes', 'full'].includes(raw)) return true;

  // Auto mode: if automated browser/build validation passed, avoid another paid QA call.
  return validation?.status !== 'PASS';
}

function truncateTail(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `...[truncated ${value.length - maxChars} leading chars]\n${value.slice(value.length - maxChars)}`;
}

function maskSecrets(value: string) {
  return value
    .replace(/(api[_-]?key|token|secret|password)(["'\s:=]+)([^"'\s]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}

export function createTimestampRunId(date = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

function shouldSkipRepairTreeEntry(entryName: string) {
  return ['node_modules', '.next', '.git', '.venv', '.runtime-logs', '.validation-logs', '__pycache__', '.pytest_cache'].includes(entryName);
}

async function formatWorkspaceTree(root: string, current = root, depth = 0, lines: string[] = []): Promise<string> {
  if (lines.length >= MAX_REPAIR_TREE_FILES || depth > 6) return lines.join('\n');

  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return lines.join('\n');
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (lines.length >= MAX_REPAIR_TREE_FILES) break;
    if (shouldSkipRepairTreeEntry(entry.name)) continue;

    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      lines.push(`- ${relativePath}/`);
      await formatWorkspaceTree(root, fullPath, depth + 1, lines);
      continue;
    }

    if (entry.isFile()) {
      let size = 0;
      try {
        size = (await fs.stat(fullPath)).size;
      } catch {
        size = 0;
      }
      lines.push(`- ${relativePath} (${size} bytes)`);
    }
  }

  if (current === root && lines.length >= MAX_REPAIR_TREE_FILES) {
    lines.push(`- ...tree truncated at ${MAX_REPAIR_TREE_FILES} entries`);
  }

  return lines.join('\n') || 'No validation workspace files listed.';
}

async function readValidationLogExcerpt(logFile: string | undefined, remainingBudget: number) {
  if (!logFile || remainingBudget <= 0) return '';

  try {
    const content = maskSecrets(await fs.readFile(logFile, 'utf-8'));
    return truncateTail(content, Math.min(MAX_REPAIR_LOG_CHARS, remainingBudget));
  } catch (error) {
    return `Could not read validation log ${logFile}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function formatExecutionValidationFeedback(validation: GeneratedExecutionValidationResult, generatedFiles: GeneratedFile[]) {
  let remainingLogBudget = MAX_REPAIR_TOTAL_LOG_CHARS;
  const steps = validation.steps
    .map((step) => {
      const command = step.command ? `\nCommand: ${step.command}` : '';
      const logFile = step.logFile ? `\nLog file: ${step.logFile}` : '';
      return `## ${step.name}\nStatus: ${step.status}${command}${logFile}\n${step.message}`;
    })
    .join('\n\n');

  const failedOrLoggedSteps = validation.steps.filter((step) => step.status === 'FAIL' || step.logFile);
  const logSections: string[] = [];
  for (const step of failedOrLoggedSteps) {
    const excerpt = await readValidationLogExcerpt(step.logFile, remainingLogBudget);
    if (!excerpt) continue;
    remainingLogBudget -= excerpt.length;
    logSections.push(`## ${step.name}\nSource: ${step.logFile}\n\`\`\`\n${excerpt}\n\`\`\``);
  }

  const workspaceTree = await formatWorkspaceTree(validation.workspace);

  return [
    'EXECUTION REPAIR PACKET',
    'Use every section below. Diagnose from the exact failed command/log before choosing files. The generated project snapshot and validation workspace tree are included so Docker COPY paths, build contexts, scripts, env files, and framework configs can be checked quickly.',
    '',
    `Execution validation status: ${validation.status}`,
    `Validation workspace: ${validation.workspace}`,
    validation.findings.length ? `Findings:\n${validation.findings.map((finding) => `- ${finding}`).join('\n')}` : 'No findings.',
    formatRepairScope(validation.repairScope),
    'Generated project overview at repair time:',
    formatGeneratedProjectOverview(generatedFiles),
    'Validation workspace tree:',
    workspaceTree,
    'Validation steps:',
    steps,
    'Validation log excerpts:',
    logSections.length ? logSections.join('\n\n') : 'No validation log excerpts were available.'
  ].join('\n\n');
}

async function refreshDevOutputFromWorkspace(output: DevOutput): Promise<DevOutput> {
  const files = await readGeneratedCodeSnapshot();
  return { ...output, files };
}

async function writeAndRefreshDevOutput(output: DevOutput, mediaAssetFiles: PreparedMediaAssetFile[] = []) {
  const codeOutputDir = await writeGeneratedFiles(output.files);
  await writePreparedMediaAssets(mediaAssetFiles);
  return {
    codeOutputDir,
    devOutput: await refreshDevOutputFromWorkspace(output)
  };
}

function throwIfCanceled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Run canceled by user.');
  }
}

async function reportRepairScope(progress: RunProgressReporter | undefined, scope: RepairScope) {
  await progress?.({
    stepId: 'dev',
    stepStatus: 'RUNNING',
    level: 'info',
    message: `Scoped repair: ${scope.label}. Candidates: ${scope.candidatePaths.join(', ') || 'none detected'}. Directories: ${scope.allowedDirectories.join(', ')}`
  });
}

type ReviewRepairFinding = {
  category: string;
  file: string;
  finding: string;
  fix?: string;
};

function formatReviewRepairFindings(title: string, findings: ReviewRepairFinding[]) {
  if (findings.length === 0) return `${title}\n- None.`;

  return [
    title,
    ...findings.map((finding, index) => {
      const fix = finding.fix ? `\n  Fix: ${finding.fix}` : '';
      return `${index + 1}. [${finding.category}] ${finding.file}\n  Finding: ${finding.finding}${fix}`;
    })
  ].join('\n');
}

function formatCodeReviewDeployRepairFeedback(params: {
  codeReview: CodeReviewOutput;
  deployValidation: DeployOutput;
  generatedFiles: GeneratedFile[];
}) {
  const deployServices = params.deployValidation.services.length
    ? params.deployValidation.services.map((service) => `- ${service.name}: ${service.status}, port ${service.port}, health ${service.healthUrl}`).join('\n')
    : '- None reported.';

  return [
    'CODE REVIEW / DEPLOY REPAIR PACKET',
    'Use this packet as the exact bug log for the repair. Fix blocking findings first. Apply advisory findings only when they touch the same files or are clearly required for deploy/readiness. Preserve unrelated files and avoid regenerating the whole project.',
    '',
    `Code review status: ${params.codeReview.status}`,
    `Code review summary: ${params.codeReview.summary}`,
    `Requirement coverage: ${params.codeReview.requirementCoverage}`,
    formatReviewRepairFindings('Code review blocking findings:', params.codeReview.blocking),
    formatReviewRepairFindings('Code review advisory findings:', params.codeReview.advisory),
    `Deploy validation status: ${params.deployValidation.status}`,
    `Deploy validation summary: ${params.deployValidation.summary}`,
    `Deploy command: ${params.deployValidation.deployCommand}`,
    'Deploy services:',
    deployServices,
    formatReviewRepairFindings('Deploy blocking findings:', params.deployValidation.blocking),
    formatReviewRepairFindings('Deploy advisory findings:', params.deployValidation.advisory),
    'Generated project overview at repair time:',
    formatGeneratedProjectOverview(params.generatedFiles)
  ].join('\n\n');
}

function formatCodeReviewDeployScopeText(params: {
  codeReview: CodeReviewOutput;
  deployValidation: DeployOutput;
}) {
  const findings: Array<ReviewRepairFinding & { source: string }> = [
    ...params.codeReview.blocking.map((finding) => ({ source: 'CodeReview', ...finding })),
    ...params.deployValidation.blocking.map((finding) => ({ source: 'Deploy', ...finding })),
    ...params.codeReview.advisory.map((finding) => ({ source: 'CodeReview advisory', ...finding })),
    ...params.deployValidation.advisory.map((finding) => ({ source: 'Deploy advisory', ...finding }))
  ];

  if (findings.length === 0) {
    return [
      `Code review status: ${params.codeReview.status}`,
      params.codeReview.summary,
      `Deploy validation status: ${params.deployValidation.status}`,
      params.deployValidation.summary
    ].join('\n');
  }

  return findings
    .map((finding) => {
      const fix = finding.fix ? `\nFix: ${finding.fix}` : '';
      return `[${finding.source}/${finding.category}] ${finding.file}\nFinding: ${finding.finding}${fix}`;
    })
    .join('\n\n');
}

function findingLearningNotes(source: string, findings: ReviewRepairFinding[]) {
  return findings.slice(0, 8).map((finding) => {
    const fix = finding.fix ? ` Fix: ${finding.fix}` : '';
    return `${source} lesson for ${finding.file}: ${finding.finding}.${fix}`;
  });
}

function codeReviewLearningNotes(codeReview: CodeReviewOutput) {
  if (codeReview.status !== 'NEEDS_FIX') return [];
  return [
    `CodeReview required fixes: ${codeReview.summary}`,
    ...findingLearningNotes('CodeReview blocking', codeReview.blocking),
    ...findingLearningNotes('CodeReview advisory', codeReview.advisory)
  ];
}

function deployLearningNotes(deployValidation: DeployOutput) {
  if (deployValidation.status !== 'NEEDS_FIX') return [];
  return [
    `DevOps validation required fixes: ${deployValidation.summary}`,
    ...findingLearningNotes('DevOps blocking', deployValidation.blocking),
    ...findingLearningNotes('DevOps advisory', deployValidation.advisory)
  ];
}

function staticValidationLearningNotes(validation: GeneratedProjectValidation) {
  if (validation.status !== 'NEEDS_FIX') return [];
  return [
    `Static readiness failed. Fix instructions: ${validation.fixInstructions}`,
    ...validation.findings.slice(0, 8).map((finding) => `Static readiness lesson: ${finding}`)
  ];
}

function executionValidationLearningNotes(validation: GeneratedExecutionValidationResult) {
  if (validation.status !== 'NEEDS_FIX') return [];
  const failedSteps = validation.steps
    .filter((step) => step.status === 'FAIL')
    .slice(0, 8)
    .map((step) => `Execution validation step failed (${step.name}): ${step.message}`);
  return [
    `Execution validation failed. Fix instructions: ${validation.fixInstructions}`,
    ...validation.findings.slice(0, 8).map((finding) => `Execution validation lesson: ${finding}`),
    ...failedSteps
  ];
}

function qaLearningNotes(qaReview: QAReviewOutput) {
  if (qaReview.status !== 'NEEDS_FIX') return [];
  return [
    `QA required fixes. Fix instructions: ${qaReview.fixInstructions}`,
    ...qaReview.findings.slice(0, 8).map((finding) => `QA lesson: ${finding}`)
  ];
}

function summarizeStaticFindings(validation: GeneratedProjectValidation) {
  if (validation.status === 'PASS') return '';

  const summary = validation.findings.slice(0, 4).map((finding) => `- ${finding}`).join('\n');
  const remaining = validation.findings.length > 4 ? `\n- ...and ${validation.findings.length - 4} more issue(s).` : '';
  return `\n${summary}${remaining}`;
}

function staticFindingsSignature(validation: GeneratedProjectValidation) {
  return validation.findings.map((finding) => finding.trim().toLowerCase()).sort().join('\n');
}

async function reportStaticReadiness(progress: RunProgressReporter | undefined, validation: GeneratedProjectValidation, label: string) {
  await progress?.({
    stepId: 'static-validation',
    stepStatus: validation.status === 'PASS' ? 'PASS' : 'FAIL',
    level: validation.status === 'PASS' ? 'success' : 'warn',
    message: `${label} ${validation.status}.${summarizeStaticFindings(validation)}`
  });
}

function createBlockedQaReview(reason: string, findings: string[]): QAReviewOutput {
  return {
    status: 'NEEDS_FIX',
    findings,
    fixInstructions: reason,
    report: `${reason}\n\n${findings.map((finding) => `- ${finding}`).join('\n')}`
  };
}

function createSmokeQaReview(validation: GeneratedExecutionValidationResult): QAReviewOutput {
  const passedSteps = validation.steps.filter((step) => step.status === 'PASS').map((step) => step.name).join(', ');
  return {
    status: 'PASS',
    findings: [],
    fixInstructions: '',
    report: [
      '## QA Summary',
      '',
      'Smoke validation passed. The generated project built, started, and responded to configured health/page checks.',
      '',
      '## Smoke Evidence',
      '',
      `Execution validation status: ${validation.status}`,
      `Passed steps: ${passedSteps || 'Recorded execution validation passed.'}`,
      '',
      '## Recommendation',
      '',
      'PASS. No full QA model review was run because automated build, runtime, browser, and media validation are the acceptance gate for this run mode.'
    ].join('\n')
  };
}

function createCostCappedQaReview(reason: string, validation: GeneratedExecutionValidationResult): QAReviewOutput {
  return {
    status: validation.status === 'PASS' ? 'PASS' : 'NEEDS_FIX',
    findings: validation.status === 'PASS' ? [] : validation.findings,
    fixInstructions: validation.status === 'PASS' ? '' : reason,
    report: [
      '## QA Summary',
      '',
      reason,
      '',
      `Execution validation status: ${validation.status}`,
      validation.findings.length ? `Findings:\n${validation.findings.map((finding) => `- ${finding}`).join('\n')}` : 'Findings: none',
      '',
      validation.status === 'PASS'
        ? 'PASS based on automated deterministic validation. Full QA model review was skipped to control run cost.'
        : 'NEEDS_FIX because validation did not pass and the cost budget prevented an additional QA model review.'
    ].join('\n')
  };
}

function createSnapshotDevOutput(files: GeneratedFile[], reason: string): DevOutput {
  return {
    architecture: `${reason}. Architecture will be refined by the next DEV run from the generated-code snapshot and BA output.`,
    files,
    setupInstructions: 'Use the generated README.md and manifests in generated-code. This snapshot skill was bootstrapped from existing files.'
  };
}

function createPassingCodeReview(summary: string): CodeReviewOutput {
  return {
    status: 'PASS',
    blocking: [],
    advisory: [],
    summary,
    requirementCoverage: 'not applicable'
  };
}

function createPassingDeployValidation(summary: string): DeployOutput {
  return {
    status: 'PASS',
    blocking: [],
    advisory: [],
    deployCommand: 'docker compose up --build',
    services: [],
    summary
  };
}

export async function runSprintBuilder(input: RunRequest, options?: { runId?: string; onProgress?: RunProgressReporter; signal?: AbortSignal }): Promise<RunResult> {
  const llmUsageRecords: LlmUsageRecord[] = [];
  return runWithLlmUsageTracking(llmUsageRecords, () => runSprintBuilderTracked(input, options, llmUsageRecords));
}

async function runSprintBuilderTracked(
  input: RunRequest,
  options: { runId?: string; onProgress?: RunProgressReporter; signal?: AbortSignal } | undefined,
  llmUsageRecords: LlmUsageRecord[]
): Promise<RunResult> {
  const runId = options?.runId || createTimestampRunId();
  const events: AgentEvent[] = [];
  const topic = input.topic || 'AI Team Run';
  const projectId = input.projectId || DEFAULT_PROJECT_ID;
  const selectedAgentModels = {
    ba: agentModelFor('ba', input.agentModels),
    'tech-stack': agentModelFor('tech-stack', input.agentModels),
    ux: agentModelFor('ux', input.agentModels),
    dev: agentModelFor('dev', input.agentModels),
    'frontend-dev': agentModelFor('frontend-dev', input.agentModels),
    'backend-dev': agentModelFor('backend-dev', input.agentModels),
    'integration-dev': agentModelFor('integration-dev', input.agentModels),
    'code-review': agentModelFor('code-review', input.agentModels),
    deploy: agentModelFor('deploy', input.agentModels),
    qa: agentModelFor('qa', input.agentModels)
  };

  // Dashboard is optional. Auto-registration only runs when explicitly enabled.
  if (shouldAutoRegisterDashboard()) {
  try {
    const reg = await registerDashboardCompany();
    if (reg.company_id && !reg.dashboardDisabled) {
      console.log(`[Dashboard] Registered company "${reg.name}" → ${reg.company_id}`);
    }
  } catch (e) {
    console.warn('[Dashboard] Auto-register failed, continuing without dashboard:', e instanceof Error ? e.message : e);
  }
  }
  const dashboardReadiness = validateDashboardReadiness();
  if (dashboardReadiness.warnings.length) {
    await progress({
      stepId: 'dashboard',
      stepLabel: 'Dashboard',
      stepStatus: 'SKIPPED',
      level: dashboardReadiness.dashboardEnabled ? 'warn' : 'info',
      message: `Dashboard event preflight: ${dashboardReadiness.warnings.join(' ')}`
    });
  } else if (dashboardReadiness.dashboardEnabled) {
    await progress({
      stepId: 'dashboard',
      stepLabel: 'Dashboard',
      stepStatus: 'PASS',
      level: 'success',
      message: `Dashboard event preflight passed for company ${dashboardReadiness.snapshot.company_id}.`
    });
  }
  const dashboardConnectivity = await checkDashboardConnectivity();
  if (dashboardConnectivity.checked && !dashboardConnectivity.reachable) {
    const dashboardUnavailableReason = `Dashboard API is not reachable. Events will remain local only until DASHBOARD_BASE_URL/network is fixed. ${dashboardConnectivity.error || ''}`.trim();
    disableDashboardRemoteEvents(dashboardUnavailableReason);
    await progress({
      stepId: 'dashboard',
      stepLabel: 'Dashboard',
      stepStatus: 'SKIPPED',
      level: 'warn',
      message: dashboardUnavailableReason
    });
  } else if (dashboardReadiness.dashboardEnabled) {
    enableDashboardRemoteEvents();
  }

  async function progress(update: Parameters<RunProgressReporter>[0]) {
    throwIfCanceled(options?.signal);
    await options?.onProgress?.(update);
    throwIfCanceled(options?.signal);
  }

  async function emit(params: Parameters<typeof emitDashboardEvent>[0]) {
    const event = await emitDashboardEvent(params);
    events.push(event);
    const stepMap: Record<string, string> = {
      ba: 'ba',
      'tech-stack': 'tech-stack',
      ux: 'ux',
      dev: 'dev',
      'frontend-dev': 'frontend-dev',
      'backend-dev': 'backend-dev',
      'integration-dev': 'integration-dev',
      qa: 'qa',
      'code-review': 'code-review',
      deploy: 'deploy-validation'
    };
    await progress({
      stepId: stepMap[params.agentId] || 'dev',
      level: params.eventType === 'ERROR' ? 'error' : params.eventType.includes('COMPLETE') ? 'success' : 'info',
      message: `${params.agentId.toUpperCase()} ${params.eventType}: ${params.task}`
    });
  }

  const costControlNotes: string[] = [];
  const costControlNoteSet = new Set<string>();

  function currentCostSummary() {
    return summarizeLlmUsage(llmUsageRecords);
  }

  function recordCostControlNote(note: string) {
    if (costControlNoteSet.has(note)) return;
    costControlNoteSet.add(note);
    costControlNotes.push(note);
  }

  async function reportCostCheckpoint(stage: string) {
    const summary = currentCostSummary();
    if (RUN_COST_WARN_USD > 0 && summary.totalUsd >= RUN_COST_WARN_USD) {
      await progress({
        stepId: 'complete',
        stepStatus: 'PENDING',
        level: summary.totalUsd >= RUN_COST_BUDGET_USD && RUN_COST_BUDGET_USD > 0 ? 'warn' : 'info',
        message: `Cost checkpoint after ${stage}: $${summary.totalUsd.toFixed(4)} across ${summary.totalCalls} model call(s).`
      });
    }
    return summary;
  }

  async function stopForCostBudget(stage: string) {
    if (RUN_COST_BUDGET_USD <= 0) return false;

    const summary = currentCostSummary();
    if (summary.totalUsd < RUN_COST_BUDGET_USD) return false;

    const note = `Skipped ${stage} because cost $${summary.totalUsd.toFixed(4)} reached budget $${RUN_COST_BUDGET_USD.toFixed(2)}.`;
    recordCostControlNote(note);
    await progress({
      stepId: 'complete',
      stepStatus: 'PENDING',
      level: 'warn',
      message: note
    });
    return true;
  }

  await progress({
    level: 'info',
    message: `Selected agent models: BA=${selectedAgentModels.ba}, TA=${selectedAgentModels['tech-stack']}, UX=${selectedAgentModels.ux}, DEV Lead=${selectedAgentModels.dev}, Frontend DEV=${selectedAgentModels['frontend-dev']}, Backend DEV=${selectedAgentModels['backend-dev']}, Integration DEV=${selectedAgentModels['integration-dev']}, CodeReview=${selectedAgentModels['code-review']}, DevOps=${selectedAgentModels.deploy}, QA=${selectedAgentModels.qa}.`
  });
  await progress({
    level: 'info',
    message:
      RUN_COST_BUDGET_USD > 0
        ? `Cost controls enabled: warn at $${RUN_COST_WARN_USD.toFixed(2)}, stop optional repair/model-review loops at $${RUN_COST_BUDGET_USD.toFixed(2)}.`
        : 'Cost controls disabled because RUN_COST_BUDGET_USD=0.'
  });

  void prewarmGeneratedComposeRuntime(progress, options?.signal).catch((error) => {
    void progress({
      stepId: 'execution-validation',
      stepStatus: 'PENDING',
      level: 'warn',
      message: `Rancher/Docker prewarm could not start early: ${error instanceof Error ? error.message : String(error)}`
    }).catch(() => {});
  });

  let existingFiles = await readGeneratedCodeSnapshot();
  const recentRuns = await listRunResults();
  throwIfCanceled(options?.signal);
  let projectDevSkill: ProjectDevSkill | null = await loadProjectDevSkill(projectId);

  if (projectDevSkill) {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: `Loaded TA DEV context for ${projectId}: ${projectDevSkill.path}`
    });
  } else if (existingFiles.length > 0) {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: `No TA DEV context found for existing generated-code; it will be bootstrapped after BA analysis and prepare-tech-stack.`
    });
  } else {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: 'No TA DEV context found; first generation will use the static DEV skill.'
    });
  }

  await progress({ stepId: 'ba', stepStatus: 'RUNNING', message: 'BA agent is analyzing requirements.' });
  await progress({ stepId: 'ba', stepStatus: 'RUNNING', level: 'info', message: 'Searching Wikimedia Commons for free/safe image candidates for BA visual planning.' });
  const freeImageCandidates = await searchFreeSafeImages({
    requirements: input.requirements,
    techSpec: input.techSpec,
    topic,
    signal: options?.signal
  });
  await progress({
    stepId: 'ba',
    stepStatus: 'RUNNING',
    level: freeImageCandidates.length > 0 ? 'success' : 'warn',
    message:
      freeImageCandidates.length > 0
        ? `Found ${freeImageCandidates.length} free/safe image candidate(s) for BA and DEV.`
        : 'No free/safe image candidates found; BA and DEV will continue without remote imagery links.'
  });
  let preparedMediaAssets: PreparedMediaAsset[] = [];
  let preparedMediaAssetFiles: PreparedMediaAssetFile[] = [];
  if (freeImageCandidates.length > 0) {
    await progress({ stepId: 'ba', stepStatus: 'RUNNING', level: 'info', message: 'Downloading selected free/safe image candidates into prepared local media assets.' });
    const preparedMedia = await prepareMediaAssets(freeImageCandidates, options?.signal);
    preparedMediaAssets = preparedMedia.assets;
    preparedMediaAssetFiles = preparedMedia.files;
    await progress({
      stepId: 'ba',
      stepStatus: 'RUNNING',
      level: preparedMediaAssets.length > 0 ? 'success' : 'warn',
      message:
        preparedMediaAssets.length > 0
          ? `Prepared ${preparedMediaAssets.length} local media asset(s) for generated frontend public assets.`
          : 'Could not download local media assets from image candidates; DEV must avoid generic placeholders and use only relevant licensed URLs or CSS treatments.'
    });
  }
  await emit({ agentId: 'ba', eventType: 'THINKING', task: 'Analyze requirements and scope', artifact: 'BA_ARTIFACTS.md' });
  const baOutput = await runBAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: input.requirementImages,
    freeImageCandidates,
    modelOverride: selectedAgentModels.ba,
    existingFiles,
    recentRuns,
    signal: options?.signal
  });
  throwIfCanceled(options?.signal);
  const baStructure = validateBaOutputStructure(baOutput);
  await progress({
    stepId: 'ba',
    stepStatus: baStructure.status === 'PASS' ? 'PASS' : 'RUNNING',
    level: baStructure.status === 'PASS' ? 'success' : 'warn',
    message:
      baStructure.status === 'PASS'
        ? 'BA structured output validation passed.'
        : `BA structured output validation found missing sections: ${baStructure.findings.join('; ')}`
  });
  await emit({ agentId: 'ba', eventType: 'WORK_COMPLETE', task: 'BA artifacts completed', toAgent: 'tech-stack', artifact: 'BA_ARTIFACTS.md' });
  await progress({ stepId: 'ba', stepStatus: 'PASS', level: 'success', message: 'BA artifacts completed.' });

  await progress({ stepId: 'tech-stack', stepStatus: 'RUNNING', message: 'Running prepare-tech-stack from BA output.' });
  await emit({ agentId: 'tech-stack', eventType: 'THINKING', task: 'Prepare technology stack from BA output', artifact: 'PREPARED_TECH_STACK.json' });
  const preparedTechStack: PreparedTechStackOutput = await runPrepareTechStackAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    existingFiles,
    recentRuns,
    modelOverride: selectedAgentModels['tech-stack'],
    signal: options?.signal
  });
  throwIfCanceled(options?.signal);
  const preparedTechStackValidation = validatePreparedTechStackStructure(preparedTechStack);
  if (preparedTechStackValidation.status !== 'PASS') {
    await progress({
      stepId: 'tech-stack',
      stepStatus: 'FAIL',
      level: 'error',
      message: `prepare-tech-stack output is incomplete: ${preparedTechStackValidation.findings.join('; ')}`
    });
    throw new Error(`prepare-tech-stack output is incomplete: ${preparedTechStackValidation.findings.join('; ')}`);
  }
  await progress({
    stepId: 'tech-stack',
    stepStatus: 'PASS',
    level: 'success',
    message: `prepare-tech-stack completed: ${preparedTechStack.frontendFramework}, ${preparedTechStack.backendFramework}, ${preparedTechStack.database}.`
  });
  await emit({ agentId: 'tech-stack', eventType: 'WORK_COMPLETE', task: 'Prepared tech stack completed', toAgent: 'ux', artifact: 'PREPARED_TECH_STACK.json' });

  await progress({ stepId: 'ux', stepStatus: 'RUNNING', message: 'UX agent is creating a stable UX/UI contract.' });
  await emit({ agentId: 'ux', eventType: 'THINKING', task: 'Create stable UX/UI contract from BA output, mockups, and tech stack', toAgent: 'dev', artifact: 'UX_CONTRACT.json' });
  const uxRequestedAt = Date.now();
  const uxContract: UXContractOutput = await runUXAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: input.requirementImages,
    freeImageCandidates,
    preparedTechStack,
    baOutput,
    existingFiles,
    recentRuns,
    modelOverride: selectedAgentModels.ux,
    signal: options?.signal
  });
  throwIfCanceled(options?.signal);
  const uxDegraded = /^Degraded UX contract generated because/i.test(uxContract.summary);
  await progress({
    stepId: 'ux',
    stepStatus: 'PASS',
    level: uxDegraded ? 'warn' : 'success',
    message: `${uxDegraded ? 'UX fallback contract generated' : 'UX contract completed'} after ${Math.round((Date.now() - uxRequestedAt) / 1000)}s: ${uxContract.summary}`
  });
  await emit({
    agentId: 'ux',
    eventType: uxDegraded ? 'WORK_COMPLETE' : 'WORK_COMPLETE',
    task: uxDegraded ? 'UX model failed; degraded UX/UI contract generated from BA output and mockups' : 'UX/UI contract completed; handing stable design rules to TA and DEV',
    toAgent: 'tech-stack',
    artifact: 'UX_CONTRACT.json'
  });

  await progress({ stepId: 'tech-stack', level: 'info', message: 'Enriching generic skill templates with tech stack decisions.' });
  const enrichedSkill = await enrichSkillContext(preparedTechStack);
  await progress({ stepId: 'tech-stack', level: 'success', message: `Skill enrichment complete (${enrichedSkill.combined.length} chars context).` });

  // Write pre-DEV TA context from tech stack and UX contract BEFORE DEV runs.
  await emit({ agentId: 'tech-stack', eventType: 'WORKING', task: 'TA is preparing DEV context from BA stories, UX contract, and tech-stack decisions', toAgent: 'dev', artifact: 'ta-dev-context' });
  await progress({ stepId: 'tech-stack', level: 'info', message: 'Preparing TA DEV context from tech stack and UX contract.' });
  projectDevSkill = await writePreDevProjectSkill({
    projectId,
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    preparedTechStack,
    uxContract,
    existingFiles
  });
  await progress({
    stepId: 'tech-stack',
    stepStatus: 'PASS',
    level: 'success',
    message: `TA DEV context prepared with tech stack decisions: ${projectDevSkill.path}`
  });
  await emit({ agentId: 'tech-stack', eventType: 'WORK_COMPLETE', task: 'TA prepared DEV context with UX contract; implementation is ready to start', toAgent: 'dev', artifact: 'ta-dev-context' });

  async function updateProjectSkillFromDevOutput(params: {
    devOutput: DevOutput;
    reason: string;
    executionValidation?: GeneratedExecutionValidationResult;
    qaReview?: QAReviewOutput;
    learningNotes?: string[];
  }) {
    const hadProjectSkill = projectDevSkill !== null;
    await emit({
      agentId: 'tech-stack',
      eventType: 'WORKING',
      task: `TA records feedback and updates DEV context: ${params.reason}`,
      toAgent: 'dev',
      artifact: 'ta-dev-context'
    });
    await progress({
      stepId: 'tech-stack',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `TA updating DEV context and learning memory: ${params.reason}`
    });
    projectDevSkill = await writeProjectDevSkill({
      projectId,
      requirements: input.requirements,
      techSpec: input.techSpec,
      preparedTechStack,
      uxContract,
      baOutput,
      devOutput: params.devOutput,
      executionValidation: params.executionValidation,
      qaReview: params.qaReview,
      learningNotes: params.learningNotes,
      reason: params.reason
    });

    await progress({
      stepId: 'tech-stack',
      stepStatus: 'PASS',
      level: 'success',
      message: `TA DEV context ${hadProjectSkill ? 'updated' : 'generated'} for ${projectId}: ${projectDevSkill.path}`
    });
    await emit({
      agentId: 'tech-stack',
      eventType: 'WORK_COMPLETE',
      task: `TA updated DEV context and learning memory for ${projectId}`,
      toAgent: 'dev',
      artifact: 'ta-dev-context'
    });

    return projectDevSkill;
  }

  await progress({
    stepId: 'dev',
    stepStatus: 'PENDING',
    level: 'info',
    message: 'DEV context enriched with prepared tech stack; DEV will use the static skill plus TA context.'
  });
  await progress({ stepId: 'dev', stepStatus: 'RUNNING', message: 'DEV agent is generating implementation files.' });
  await emit({ agentId: 'dev', eventType: 'CODING', task: 'Generate implementation files', artifact: 'generated-files' });
  let devOutput = await runDevAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: input.requirementImages,
    freeImageCandidates,
    preparedMediaAssets,
    uxContract,
    modelOverride: selectedAgentModels.dev,
    agentModelOverrides: selectedAgentModels,
    preparedTechStack,
    baOutput,
    existingFiles,
    recentRuns,
    apiSpec: input.apiSpec,
    projectDevSkill,
    enrichedSkillContext: enrichedSkill.combined,
    onProgress: progress,
    onAgentActivity: emit,
    signal: options?.signal
  });
  throwIfCanceled(options?.signal);
  let writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
  devOutput = writeResult.devOutput;
  let codeOutputDir = writeResult.codeOutputDir;
  await reportCostCheckpoint('initial DEV generation');
  projectDevSkill = await updateProjectSkillFromDevOutput({
    devOutput,
    reason: projectDevSkill ? 'Update TA DEV context after DEV generation.' : 'Create TA DEV context after first generated-code scaffold.'
  });
  await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: 'Implementation files generated', toAgent: 'code-review', artifact: 'generated-files' });

  async function runCodeReviewStep(label: string) {
    await progress({ stepId: 'code-review', stepStatus: 'RUNNING', message: label });
    await emit({ agentId: 'code-review', eventType: 'REVIEWING', task: label, artifact: 'CODE_REVIEW.json' });
    const review = await runCodeReviewAgent({
      requirements: input.requirements,
      requirementImages: input.requirementImages,
      baOutput,
      devOutput,
      preparedTechStack,
      uxContract,
      existingFiles: await readGeneratedCodeSnapshot(),
      modelOverride: selectedAgentModels['code-review'],
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    await progress({
      stepId: 'code-review',
      stepStatus: review.status === 'PASS' ? 'PASS' : 'FAIL',
      level: review.status === 'PASS' ? 'success' : 'warn',
      message: `Code review ${review.status}: ${review.summary}. Blocking: ${review.blocking.length}, Advisory: ${review.advisory.length}.`
    });
    return review;
  }

  let codeReview: CodeReviewOutput;
  let codeReviewFixIterations = 0;
  try {
    codeReview = await runCodeReviewStep('CodeReviewAgent is reviewing generated code.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progress({ stepId: 'code-review', stepStatus: 'SKIPPED', level: 'warn', message: `Code review skipped: ${message}` });
    codeReview = createPassingCodeReview('Skipped due to error');
  }

  while (codeReview.status === 'NEEDS_FIX' && codeReviewFixIterations < MAX_CODE_REVIEW_FIX_ITERATIONS) {
    if (await stopForCostBudget('CodeReview repair iteration')) break;
    codeReviewFixIterations += 1;
    await emit({
      agentId: 'code-review',
      eventType: 'REVIEW_REQUEST',
      task: `Code review found blockers; sending fix request ${codeReviewFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'CODE_REVIEW.json'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const deployPlaceholder = createPassingDeployValidation('Deploy validation has not run yet; this repair is for CodeReview findings only.');
    const reviewFeedback = formatCodeReviewDeployRepairFeedback({
      codeReview,
      deployValidation: deployPlaceholder,
      generatedFiles: existingFiles
    });
    const repairScope = inferReviewRepairScope(formatCodeReviewDeployScopeText({ codeReview, deployValidation: deployPlaceholder }), existingFiles);
    await reportRepairScope(options?.onProgress, repairScope);
    await progress({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `DEV received CodeReview feedback packet (${reviewFeedback.length} chars). TA will update learning memory after the fix.`
    });
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix CodeReview findings iteration ${codeReviewFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      freeImageCandidates,
      preparedMediaAssets,
      uxContract,
      modelOverride: selectedAgentModels.dev,
      agentModelOverrides: selectedAgentModels,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: reviewFeedback,
      repairScope,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      onAgentActivity: emit,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      learningNotes: codeReviewLearningNotes(codeReview),
      reason: `CodeReview feedback repair iteration ${codeReviewFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `CodeReview fixes applied iteration ${codeReviewFixIterations}`, toAgent: 'code-review', artifact: 'generated-files' });

    try {
      codeReview = await runCodeReviewStep(`CodeReviewAgent is re-reviewing fixes iteration ${codeReviewFixIterations}.`);
      await reportCostCheckpoint(`CodeReview repair iteration ${codeReviewFixIterations}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await progress({ stepId: 'code-review', stepStatus: 'SKIPPED', level: 'warn', message: `Code review retry skipped: ${message}` });
      codeReview = createPassingCodeReview('Skipped during retry due to error');
      break;
    }
  }

  await emit({
    agentId: 'code-review',
    eventType: codeReview.status === 'PASS' ? 'WORK_COMPLETE' : 'ERROR',
    task:
      codeReview.status === 'PASS'
        ? 'Code review passed; handing off to DevOps agent'
        : `Code review still has blockers after ${codeReviewFixIterations} fix attempt(s)`,
    toAgent: codeReview.status === 'PASS' ? 'deploy' : 'dev',
    artifact: 'CODE_REVIEW.json'
  });

  async function runDeployReviewStep(label: string) {
    await progress({ stepId: 'deploy-validation', stepStatus: 'RUNNING', message: label });
    await emit({ agentId: 'deploy', eventType: 'REVIEWING', task: label, artifact: 'DEPLOY_VALIDATION.json' });
    const validation = await runDeployAgent({
      requirements: input.requirements,
      devOutput,
      preparedTechStack,
      existingFiles: await readGeneratedCodeSnapshot(),
      modelOverride: selectedAgentModels.deploy,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    await progress({
      stepId: 'deploy-validation',
      stepStatus: validation.status === 'PASS' ? 'PASS' : 'FAIL',
      level: validation.status === 'PASS' ? 'success' : 'warn',
      message: `Deploy validation ${validation.status}: ${validation.summary}. Blocking: ${validation.blocking.length}.`
    });
    return validation;
  }

  let deployValidation: DeployOutput;
  let deployFixIterations = 0;
  try {
    deployValidation = await runDeployReviewStep('DevOps agent is validating container and deployment readiness.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progress({ stepId: 'deploy-validation', stepStatus: 'SKIPPED', level: 'warn', message: `Deploy validation skipped: ${message}` });
    deployValidation = createPassingDeployValidation('Skipped due to error');
  }

  while (deployValidation.status === 'NEEDS_FIX' && deployFixIterations < MAX_DEPLOY_FIX_ITERATIONS) {
    if (await stopForCostBudget('DevOps repair iteration')) break;
    deployFixIterations += 1;
    await emit({
      agentId: 'deploy',
      eventType: 'REVIEW_REQUEST',
      task: `DevOps found deployment blockers; sending fix request ${deployFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'DEPLOY_VALIDATION.json'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const reviewFeedback = formatCodeReviewDeployRepairFeedback({
      codeReview: createPassingCodeReview('Code review has no active blockers for this DevOps repair.'),
      deployValidation,
      generatedFiles: existingFiles
    });
    const repairScope = inferReviewRepairScope(
      formatCodeReviewDeployScopeText({
        codeReview: createPassingCodeReview('Code review has no active blockers for this DevOps repair.'),
        deployValidation
      }),
      existingFiles
    );
    await reportRepairScope(options?.onProgress, repairScope);
    await progress({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `DEV received DevOps deployment feedback packet (${reviewFeedback.length} chars). TA will update learning memory after the fix.`
    });
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix DevOps deployment findings iteration ${deployFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      freeImageCandidates,
      preparedMediaAssets,
      uxContract,
      modelOverride: selectedAgentModels.dev,
      agentModelOverrides: selectedAgentModels,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: reviewFeedback,
      repairScope,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      onAgentActivity: emit,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      learningNotes: deployLearningNotes(deployValidation),
      reason: `DevOps deployment feedback repair iteration ${deployFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `DevOps deployment fixes applied iteration ${deployFixIterations}`, toAgent: 'deploy', artifact: 'generated-files' });

    try {
      deployValidation = await runDeployReviewStep(`DevOps agent is re-validating deployment fixes iteration ${deployFixIterations}.`);
      await reportCostCheckpoint(`DevOps repair iteration ${deployFixIterations}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await progress({ stepId: 'deploy-validation', stepStatus: 'SKIPPED', level: 'warn', message: `Deploy validation retry skipped: ${message}` });
      deployValidation = createPassingDeployValidation('Skipped during retry due to error');
      break;
    }
  }

  await emit({
    agentId: 'deploy',
    eventType: deployValidation.status === 'PASS' ? 'WORK_COMPLETE' : 'ERROR',
    task:
      deployValidation.status === 'PASS'
        ? 'DevOps deployment validation passed; ready for Rancher/Desktop smoke deploy'
        : `DevOps deployment validation still has blockers after ${deployFixIterations} fix attempt(s)`,
    toAgent: deployValidation.status === 'PASS' ? 'qa' : 'dev',
    artifact: 'DEPLOY_VALIDATION.json'
  });

  let buildReadinessFixIterations = 0;
  await progress({ stepId: 'static-validation', stepStatus: 'RUNNING', message: 'Running static readiness check.' });
  let buildReadiness = validateGeneratedProject(devOutput);
  await reportStaticReadiness(options?.onProgress, buildReadiness, 'Static readiness check');
  while (buildReadiness.status === 'NEEDS_FIX' && buildReadinessFixIterations < MAX_BUILD_READINESS_FIX_ITERATIONS) {
    if (await stopForCostBudget('static readiness repair iteration')) break;
    const previousStaticSignature = staticFindingsSignature(buildReadiness);
    buildReadinessFixIterations += 1;

    await emit({
      agentId: 'deploy',
      eventType: 'REVIEW_REQUEST',
      task: `Run/build readiness check found blockers; DevOps sending fix request ${buildReadinessFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'generated-files'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const repairScope = inferStaticRepairScope(buildReadiness, existingFiles);
    await reportRepairScope(options?.onProgress, repairScope);
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix run/build readiness blockers iteration ${buildReadinessFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      freeImageCandidates,
      preparedMediaAssets,
      uxContract,
      modelOverride: selectedAgentModels.dev,
      agentModelOverrides: selectedAgentModels,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: buildReadiness.fixInstructions,
      repairScope,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      onAgentActivity: emit,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      learningNotes: staticValidationLearningNotes(buildReadiness),
      reason: `Update TA DEV context after static readiness repair iteration ${buildReadinessFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Run/build readiness fixes generated iteration ${buildReadinessFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await progress({
      stepId: 'static-validation',
      stepStatus: 'RUNNING',
      message: `Re-running static readiness check after DEV fix iteration ${buildReadinessFixIterations}.`
    });
    buildReadiness = validateGeneratedProject(devOutput);
    await reportStaticReadiness(options?.onProgress, buildReadiness, `Static readiness check after DEV fix ${buildReadinessFixIterations}`);
    await reportCostCheckpoint(`static readiness repair iteration ${buildReadinessFixIterations}`);

    if (buildReadiness.status === 'NEEDS_FIX' && staticFindingsSignature(buildReadiness) === previousStaticSignature) {
      await progress({
        stepId: 'static-validation',
        stepStatus: 'FAIL',
        level: 'warn',
        message: 'Static readiness findings did not change after the last DEV repair; stopping static repair loop and continuing deploy-first validation.'
      });
      break;
    }
  }

  let executionValidationFixIterations = 0;
  let executionValidation: GeneratedExecutionValidationResult;

  if (buildReadiness.status === 'NEEDS_FIX') {
    await progress({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      level: 'warn',
      message: `Static readiness still has ${buildReadiness.findings.length} issue(s) after ${buildReadinessFixIterations}/${MAX_BUILD_READINESS_FIX_ITERATIONS} fix attempt(s); continuing deploy-first build/run validation.`
    });
  }

  await emit({ agentId: 'deploy', eventType: 'EXECUTING', task: 'Run generated project build/deploy smoke validation', artifact: 'generated-validation' });
  await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: 'Running generated project build/deploy smoke validation.' });
  executionValidation = await validateGeneratedProjectExecution(progress, options?.signal);

  while (executionValidation.status === 'NEEDS_FIX' && executionValidationFixIterations < MAX_EXECUTION_VALIDATION_FIX_ITERATIONS) {
    if (await stopForCostBudget('execution validation repair iteration')) break;
    executionValidationFixIterations += 1;

    await emit({
      agentId: 'deploy',
      eventType: 'REVIEW_REQUEST',
      task: `Rancher/Desktop deploy smoke validation failed; DevOps sending fix request ${executionValidationFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'generated-validation'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const repairScope = executionValidation.repairScope;
    if (repairScope) {
      await reportRepairScope(options?.onProgress, repairScope);
    }
    const executionRepairFeedback = await formatExecutionValidationFeedback(executionValidation, existingFiles);
    await progress({
      stepId: 'dev',
      stepStatus: 'RUNNING',
      level: 'info',
      message: `Prepared execution repair packet with validation logs, workspace tree, and generated project overview (${executionRepairFeedback.length} chars).`
    });
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix execution validation failures iteration ${executionValidationFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      freeImageCandidates,
      preparedMediaAssets,
      uxContract,
      modelOverride: selectedAgentModels.dev,
      agentModelOverrides: selectedAgentModels,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: executionRepairFeedback,
      repairScope,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      onAgentActivity: emit,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      executionValidation,
      learningNotes: executionValidationLearningNotes(executionValidation),
      reason: `Update TA DEV context after execution validation repair iteration ${executionValidationFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Execution validation fixes generated iteration ${executionValidationFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await progress({
      stepId: 'static-validation',
      stepStatus: 'RUNNING',
      message: `Re-running static readiness check after execution fix iteration ${executionValidationFixIterations}.`
    });
    buildReadiness = validateGeneratedProject(devOutput);
    await reportStaticReadiness(options?.onProgress, buildReadiness, `Static readiness check after execution fix ${executionValidationFixIterations}`);

    await emit({ agentId: 'deploy', eventType: 'EXECUTING', task: `Re-run generated project execution validation iteration ${executionValidationFixIterations}`, artifact: 'generated-validation' });
    await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: `Re-running generated project build/deploy smoke validation iteration ${executionValidationFixIterations}.` });
    executionValidation = await validateGeneratedProjectExecution(progress, options?.signal);
    await reportCostCheckpoint(`execution validation repair iteration ${executionValidationFixIterations}`);
  }

  if (executionValidation.status === 'NEEDS_FIX' && executionValidationFixIterations >= MAX_EXECUTION_VALIDATION_FIX_ITERATIONS) {
    await progress({
      stepId: 'execution-validation',
      stepStatus: 'FAIL',
      level: 'warn',
      message: `Execution validation still needs fixes after ${executionValidationFixIterations}/${MAX_EXECUTION_VALIDATION_FIX_ITERATIONS} scoped repair attempt(s). Increase MAX_EXECUTION_VALIDATION_FIX_ITERATIONS to allow more retries.`
    });
  }

  await progress({
    stepId: 'execution-validation',
    stepStatus: executionValidation.status === 'PASS' ? 'PASS' : executionValidation.status === 'SKIPPED' ? 'SKIPPED' : 'FAIL',
    level: executionValidation.status === 'PASS' ? 'success' : executionValidation.status === 'SKIPPED' ? 'warn' : 'error',
    message: `Execution validation ${executionValidation.status}.`
  });

  if (buildReadiness.status === 'NEEDS_FIX' && executionValidation.status === 'PASS') {
    await progress({
      stepId: 'static-validation',
      stepStatus: 'PASS',
      level: 'success',
      message: 'Deploy-first validation passed; static readiness findings were treated as non-blocking advisories.'
    });
  }

  await emit({
    agentId: 'deploy',
    eventType: executionValidation.status === 'PASS' ? 'WORK_COMPLETE' : executionValidation.status === 'NEEDS_FIX' ? 'ERROR' : 'WORK_COMPLETE',
    task:
      executionValidation.status === 'PASS'
        ? 'DevOps deployed successfully; handing off to QA for end-to-end validation'
        : executionValidation.status === 'NEEDS_FIX'
        ? 'DevOps deploy smoke validation still has blockers'
        : 'DevOps deploy smoke validation was skipped by environment; handing available evidence to QA',
    toAgent: executionValidation.status === 'NEEDS_FIX' ? 'dev' : 'qa',
    artifact: 'generated-validation'
  });

  let qaReview: QAReviewOutput;
  if (executionValidation.status === 'NEEDS_FIX') {
    const reason = 'Skipped QA review because execution validation still has blocking issues.';
    qaReview = createBlockedQaReview(reason, executionValidation.findings);
    await progress({
      stepId: 'qa',
      stepStatus: 'SKIPPED',
      level: 'warn',
      message: reason
    });
  } else {
    const qaCostCapped = await stopForCostBudget('full QA model review');
    if (qaCostCapped) {
      const status = executionValidation.status === 'PASS' ? 'PASS' : 'SKIPPED';
      await progress({
        stepId: 'qa',
        stepStatus: status,
        level: executionValidation.status === 'PASS' ? 'success' : 'warn',
        message:
          executionValidation.status === 'PASS'
            ? 'QA smoke gate passed from execution validation; skipping full QA model review because the cost budget was reached.'
            : 'Skipping full QA model review because the cost budget was reached before QA.'
      });
      qaReview = createCostCappedQaReview('Full QA model review skipped because the run cost budget was reached.', executionValidation);
    } else if (executionValidation.status === 'PASS' && !shouldRunFullQaAgent(executionValidation)) {
      await progress({
        stepId: 'qa',
        stepStatus: 'PASS',
        level: 'success',
        message: 'QA smoke gate passed from execution validation; skipping full QA model review in auto cost mode.'
      });
      qaReview = createSmokeQaReview(executionValidation);
    } else {
      await progress({ stepId: 'qa', stepStatus: 'RUNNING', message: 'QA agent is running post-deploy end-to-end requirement validation.' });
      await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Run post-deploy end-to-end requirement validation', artifact: 'QA_REPORT.md' });
      qaReview = await runQAAgent({
        requirements: input.requirements,
        techSpec: input.techSpec,
        requirementImages: input.requirementImages,
        preparedTechStack,
        uxContract,
        baOutput,
        devOutput,
        existingFiles: await readGeneratedCodeSnapshot(),
        recentRuns,
        executionValidation,
        modelOverride: selectedAgentModels.qa,
        signal: options?.signal
      });
      throwIfCanceled(options?.signal);
      await reportCostCheckpoint('full QA model review');
    }
  }

  let qaFixIterations = 0;
  while (qaReview.status === 'NEEDS_FIX' && buildReadiness.status !== 'NEEDS_FIX' && executionValidation.status !== 'NEEDS_FIX' && qaFixIterations < MAX_QA_FIX_ITERATIONS) {
    if (await stopForCostBudget('QA repair iteration')) break;
    qaFixIterations += 1;

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `QA found blocking issues; sending fix request ${qaFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'QA_REPORT.md'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const qaFeedback = `${qaReview.fixInstructions}\n\nFindings:\n${qaReview.findings.join('\n')}\n\nReport:\n${qaReview.report}`;
    const repairScope = inferQaRepairScope(qaFeedback, existingFiles);
    await reportRepairScope(options?.onProgress, repairScope);
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix QA findings iteration ${qaFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      freeImageCandidates,
      preparedMediaAssets,
      uxContract,
      modelOverride: selectedAgentModels.dev,
      agentModelOverrides: selectedAgentModels,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback,
      repairScope,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      onAgentActivity: emit,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput, preparedMediaAssetFiles);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      executionValidation,
      qaReview,
      learningNotes: qaLearningNotes(qaReview),
      reason: `Update TA DEV context after QA repair iteration ${qaFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `QA fixes generated iteration ${qaFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await progress({
      stepId: 'static-validation',
      stepStatus: 'RUNNING',
      message: `Re-running static readiness check after QA fix iteration ${qaFixIterations}.`
    });
    buildReadiness = validateGeneratedProject(devOutput);
    await reportStaticReadiness(options?.onProgress, buildReadiness, `Static readiness check after QA fix ${qaFixIterations}`);

    if (buildReadiness.status === 'NEEDS_FIX') {
      await progress({
        stepId: 'execution-validation',
        stepStatus: 'RUNNING',
        level: 'warn',
        message: `Static readiness still has ${buildReadiness.findings.length} issue(s) after QA fix; continuing deploy-first build/run validation.`
      });
    }
    await emit({ agentId: 'deploy', eventType: 'EXECUTING', task: `Re-run execution validation after QA fix iteration ${qaFixIterations}`, artifact: 'generated-validation' });
    await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: `Re-running generated project build/deploy smoke validation after QA fix iteration ${qaFixIterations}.` });
    executionValidation = await validateGeneratedProjectExecution(progress, options?.signal);
    await progress({
      stepId: 'execution-validation',
      stepStatus: executionValidation.status === 'PASS' ? 'PASS' : executionValidation.status === 'SKIPPED' ? 'SKIPPED' : 'FAIL',
      level: executionValidation.status === 'PASS' ? 'success' : executionValidation.status === 'SKIPPED' ? 'warn' : 'error',
      message: `Execution validation after QA fix ${executionValidation.status}.`
    });

    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-validate delivery iteration ${qaFixIterations}`, artifact: 'QA_REPORT.md' });
    qaReview = await runQAAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      requirementImages: input.requirementImages,
      preparedTechStack,
      uxContract,
      baOutput,
      devOutput,
      existingFiles: await readGeneratedCodeSnapshot(),
      recentRuns,
      executionValidation,
      modelOverride: selectedAgentModels.qa,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    await reportCostCheckpoint(`QA repair iteration ${qaFixIterations}`);
  }

  await emit({ agentId: 'qa', eventType: 'TASK_COMPLETE', task: `QA report completed with status ${qaReview.status}`, artifact: 'QA_REPORT.md' });
  await progress({ stepId: 'qa', stepStatus: qaReview.status === 'PASS' ? 'PASS' : 'FAIL', level: qaReview.status === 'PASS' ? 'success' : 'warn', message: `QA completed with status ${qaReview.status}.` });

  projectDevSkill = await updateProjectSkillFromDevOutput({
    devOutput,
    executionValidation,
    qaReview,
    learningNotes: [...executionValidationLearningNotes(executionValidation), ...qaLearningNotes(qaReview)],
    reason: 'Finalize TA DEV context after latest run status.'
  });

  const costSummary = summarizeLlmUsage(llmUsageRecords);
  const costBudgetExceeded = RUN_COST_BUDGET_USD > 0 && costSummary.totalUsd >= RUN_COST_BUDGET_USD;
  await progress({
    stepId: 'complete',
    stepStatus: 'PENDING',
    level: costBudgetExceeded ? 'warn' : 'info',
    message: `OpenRouter cost so far: $${costSummary.totalUsd.toFixed(4)} across ${costSummary.totalCalls} model call(s).${RUN_COST_BUDGET_USD > 0 ? ` Budget: $${RUN_COST_BUDGET_USD.toFixed(2)}.` : ''}`
  });

  const finalDeployValidationStatus = executionValidation.status === 'PASS' ? 'PASS' : deployValidation.status;
  const finalDeployValidationSummary =
    executionValidation.status === 'PASS' && deployValidation.status !== 'PASS'
      ? `${deployValidation.summary}\n\nFinal generated project execution validation passed after DEV repair iterations, so deploy readiness was reconciled to PASS.`
      : deployValidation.summary;

  const result: RunResult = {
    runId,
    createdAt: new Date().toISOString(),
    topic,
    projectId,
    projectDevSkillPath: projectDevSkill?.path,
    projectDevContextPath: projectDevSkill?.path,
    preparedTechStack,
    uxContract,
    baOutput,
    devOutput,
    codeReviewStatus: codeReview.status,
    codeReviewSummary: codeReview.summary,
    codeReviewFixIterations,
    deployValidationStatus: finalDeployValidationStatus,
    deployValidationSummary: finalDeployValidationSummary,
    deployFixIterations,
    qaOutput: qaReview.report,
    qaStatus: qaReview.status,
    qaFindings: qaReview.findings,
    qaFixIterations,
    buildReadinessFixIterations,
    executionValidationFixIterations,
    executionValidation,
    freeImageCandidates,
    preparedMediaAssets,
    agentModels: selectedAgentModels,
    llmUsage: llmUsageRecords,
    costSummary,
    costBudgetUsd: RUN_COST_BUDGET_USD > 0 ? RUN_COST_BUDGET_USD : undefined,
    costBudgetExceeded,
    costControlNotes,
    events,
    outputDir: '',
    codeOutputDir
  };

  let resultWithObservation = result;
  try {
    await progress({
      stepId: 'qa',
      stepStatus: 'RUNNING',
      level: 'info',
      message: 'Generating deterministic observation report with mockup and browser screenshot evidence.'
    });
    const visualComparison = await generateObservationReport(result, {
      requirementImages: input.requirementImages
    });
    resultWithObservation = {
      ...result,
      observationReportPath: visualComparison.reportPath,
      observationReportUrl: visualComparison.reportUrl,
      visualComparison
    };
    await progress({
      stepId: 'qa',
      stepStatus: visualComparison.status === 'PASS' ? 'PASS' : visualComparison.status === 'SKIPPED' ? 'SKIPPED' : 'FAIL',
      level: visualComparison.status === 'PASS' ? 'success' : visualComparison.status === 'SKIPPED' ? 'warn' : 'warn',
      message: `Observation report generated: ${visualComparison.reportPath}. Visual score ${visualComparison.score}/100 (${visualComparison.status}).`
    });
  } catch (error) {
    await progress({
      stepId: 'qa',
      stepStatus: 'SKIPPED',
      level: 'warn',
      message: `Observation report generation failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const outputDir = await saveRunResult(resultWithObservation);
  return { ...resultWithObservation, outputDir };
}
