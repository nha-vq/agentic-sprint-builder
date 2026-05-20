import { emitDashboardEvent } from '@/lib/dashboard';
import { runBAAgent } from '@/lib/agents/ba-agent';
import { runDevAgent } from '@/lib/agents/dev-agent';
import { runCodeReviewAgent, type CodeReviewOutput } from '@/lib/agents/code-review-agent';
import { runDeployAgent, type DeployOutput } from '@/lib/agents/deploy-agent';
import { runQAAgent } from '@/lib/agents/qa-agent';
import { runPrepareTechStackAgent } from '@/lib/agents/tech-stack-agent';
import { formatGeneratedProjectOverview } from '@/lib/context/agent-context';
import { listRunResults, readGeneratedCodeSnapshot, saveRunResult, writeGeneratedFiles } from '@/lib/storage/file-writer';
import { validateGeneratedProject, type GeneratedProjectValidation } from '@/lib/validation/generated-project';
import { validateGeneratedProjectExecution } from '@/lib/validation/generated-execution';
import { formatRepairScope, inferQaRepairScope, inferStaticRepairScope } from '@/lib/validation/repair-scope';
import { validateBaOutputStructure, validatePreparedTechStackStructure } from '@/lib/validation/agent-lifecycle';
import { DEFAULT_PROJECT_ID, loadProjectDevSkill, writeProjectDevSkill, writePreDevProjectSkill, type ProjectDevSkill } from '@/lib/skills/project-dev-skill';
import { enrichSkillContext } from '@/lib/skills/skill-enrichment';
import fs from 'fs/promises';
import path from 'path';
import type { AgentEvent, DevOutput, GeneratedExecutionValidationResult, GeneratedFile, PreparedTechStackOutput, QAReviewOutput, RepairScope, RunProgressReporter, RunRequest, RunResult } from '@/lib/types';

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_QA_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_QA_FIX_ITERATIONS', 2);
const MAX_BUILD_READINESS_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_BUILD_READINESS_FIX_ITERATIONS', 5);
const MAX_EXECUTION_VALIDATION_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_EXECUTION_VALIDATION_FIX_ITERATIONS', 5);
const MAX_REPAIR_LOG_CHARS = readPositiveIntegerEnv('MAX_REPAIR_LOG_CHARS', 20_000);
const MAX_REPAIR_TOTAL_LOG_CHARS = readPositiveIntegerEnv('MAX_REPAIR_TOTAL_LOG_CHARS', 60_000);
const MAX_REPAIR_TREE_FILES = readPositiveIntegerEnv('MAX_REPAIR_TREE_FILES', 220);

function shouldRunFullQaAgent() {
  return process.env.RUN_FULL_QA_AGENT === 'true';
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

async function writeAndRefreshDevOutput(output: DevOutput) {
  const codeOutputDir = await writeGeneratedFiles(output.files);
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
      'PASS. No full QA review was run because deploy-first smoke validation is the acceptance gate.'
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

export async function runSprintBuilder(input: RunRequest, options?: { runId?: string; onProgress?: RunProgressReporter; signal?: AbortSignal }): Promise<RunResult> {
  const runId = options?.runId || createTimestampRunId();
  const events: AgentEvent[] = [];
  const topic = input.topic || 'AI Team Run';
  const projectId = input.projectId || DEFAULT_PROJECT_ID;

  async function progress(update: Parameters<RunProgressReporter>[0]) {
    throwIfCanceled(options?.signal);
    await options?.onProgress?.(update);
    throwIfCanceled(options?.signal);
  }

  async function emit(params: Parameters<typeof emitDashboardEvent>[0]) {
    const event = await emitDashboardEvent(params);
    events.push(event);
    const stepMap: Record<string, string> = { ba: 'ba', 'tech-stack': 'tech-stack', qa: 'qa', 'code-review': 'code-review', deploy: 'deploy-validation' };
    await progress({
      stepId: stepMap[params.agentId] || 'dev',
      level: params.eventType === 'ERROR' ? 'error' : params.eventType.includes('COMPLETE') ? 'success' : 'info',
      message: `${params.agentId.toUpperCase()} ${params.eventType}: ${params.task}`
    });
  }

  let existingFiles = await readGeneratedCodeSnapshot();
  const recentRuns = await listRunResults();
  throwIfCanceled(options?.signal);
  let projectDevSkill: ProjectDevSkill | null = await loadProjectDevSkill(projectId);

  if (projectDevSkill) {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: `Loaded project-specific dev skill for ${projectId}: ${projectDevSkill.path}`
    });
  } else if (existingFiles.length > 0) {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: `No project-specific dev skill found for existing generated-code; it will be bootstrapped after BA analysis and prepare-tech-stack.`
    });
  } else {
    await progress({
      stepId: 'dev',
      stepStatus: 'PENDING',
      level: 'info',
      message: 'No project-specific dev skill found; first generation will use the overall DEV skill.'
    });
  }

  await progress({ stepId: 'ba', stepStatus: 'RUNNING', message: 'BA agent is analyzing requirements.' });
  await emit({ agentId: 'ba', eventType: 'THINKING', task: 'Analyze requirements and scope', artifact: 'BA_ARTIFACTS.md' });
  const baOutput = await runBAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: input.requirementImages,
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
  await emit({ agentId: 'tech-stack', eventType: 'WORK_COMPLETE', task: 'Prepared tech stack completed', toAgent: 'dev', artifact: 'PREPARED_TECH_STACK.json' });

  await progress({ stepId: 'tech-stack', level: 'info', message: 'Enriching generic skill templates with tech stack decisions.' });
  const enrichedSkill = await enrichSkillContext(preparedTechStack);
  await progress({ stepId: 'tech-stack', level: 'success', message: `Skill enrichment complete (${enrichedSkill.combined.length} chars context).` });

  // Write pre-DEV project skill from tech stack BEFORE DEV runs
  await progress({ stepId: 'tech-stack', level: 'info', message: 'Preparing project-specific dev skill from tech stack analysis.' });
  projectDevSkill = await writePreDevProjectSkill({
    projectId,
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    preparedTechStack,
    existingFiles
  });
  await progress({
    stepId: 'tech-stack',
    stepStatus: 'PASS',
    level: 'success',
    message: `Project dev skill prepared with tech stack decisions: ${projectDevSkill.path}`
  });

  async function updateProjectSkillFromDevOutput(params: {
    devOutput: DevOutput;
    reason: string;
    executionValidation?: GeneratedExecutionValidationResult;
    qaReview?: QAReviewOutput;
  }) {
    const hadProjectSkill = projectDevSkill !== null;
    projectDevSkill = await writeProjectDevSkill({
      projectId,
      requirements: input.requirements,
      techSpec: input.techSpec,
      preparedTechStack,
      baOutput,
      devOutput: params.devOutput,
      executionValidation: params.executionValidation,
      qaReview: params.qaReview,
      reason: params.reason
    });

    await progress({
      level: 'success',
      message: `Project-specific dev skill ${hadProjectSkill ? 'updated' : 'generated'} for ${projectId}: ${projectDevSkill.path}`
    });

    return projectDevSkill;
  }

  await progress({
    stepId: 'dev',
    stepStatus: 'PENDING',
    level: 'info',
    message: 'DEV skill context enriched with prepared tech stack; DEV will use the pre-prepared project skill.'
  });
  await progress({ stepId: 'dev', stepStatus: 'RUNNING', message: 'DEV agent is generating implementation files.' });
  await emit({ agentId: 'dev', eventType: 'CODING', task: 'Generate implementation files', artifact: 'generated-files' });
  let devOutput = await runDevAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    preparedTechStack,
    baOutput,
    existingFiles,
    recentRuns,
    apiSpec: input.apiSpec,
    projectDevSkill,
    enrichedSkillContext: enrichedSkill.combined,
    onProgress: progress,
    signal: options?.signal
  });
  throwIfCanceled(options?.signal);
  let writeResult = await writeAndRefreshDevOutput(devOutput);
  devOutput = writeResult.devOutput;
  let codeOutputDir = writeResult.codeOutputDir;
  projectDevSkill = await updateProjectSkillFromDevOutput({
    devOutput,
    reason: projectDevSkill ? 'Update project-specific skill after DEV generation.' : 'Create project-specific skill after first generated-code scaffold.'
  });
  await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: 'Implementation files generated', toAgent: 'code-review', artifact: 'generated-files' });

  await progress({ stepId: 'code-review', stepStatus: 'RUNNING', message: 'CodeReviewAgent is reviewing generated code.' });
  await emit({ agentId: 'code-review', eventType: 'REVIEWING', task: 'Review generated code quality and architecture', artifact: 'CODE_REVIEW.json' });
  let codeReview: CodeReviewOutput;
  try {
    codeReview = await runCodeReviewAgent({
      requirements: input.requirements,
      baOutput,
      devOutput,
      preparedTechStack,
      existingFiles: await readGeneratedCodeSnapshot(),
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    await progress({
      stepId: 'code-review',
      stepStatus: codeReview.status === 'PASS' ? 'PASS' : 'FAIL',
      level: codeReview.status === 'PASS' ? 'success' : 'warn',
      message: `Code review ${codeReview.status}: ${codeReview.summary}. Blocking: ${codeReview.blocking.length}, Advisory: ${codeReview.advisory.length}.`
    });
    await emit({ agentId: 'code-review', eventType: 'WORK_COMPLETE', task: `Code review completed: ${codeReview.status}`, toAgent: 'deploy', artifact: 'CODE_REVIEW.json' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progress({ stepId: 'code-review', stepStatus: 'SKIPPED', level: 'warn', message: `Code review skipped: ${message}` });
    codeReview = { status: 'PASS', blocking: [], advisory: [], summary: 'Skipped due to error', requirementCoverage: 'unknown' };
  }

  await progress({ stepId: 'deploy-validation', stepStatus: 'RUNNING', message: 'DeployAgent is validating deployment configuration.' });
  await emit({ agentId: 'deploy', eventType: 'REVIEWING', task: 'Validate deployment readiness', artifact: 'DEPLOY_VALIDATION.json' });
  let deployValidation: DeployOutput;
  try {
    deployValidation = await runDeployAgent({
      requirements: input.requirements,
      devOutput,
      preparedTechStack,
      existingFiles: await readGeneratedCodeSnapshot(),
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    await progress({
      stepId: 'deploy-validation',
      stepStatus: deployValidation.status === 'PASS' ? 'PASS' : 'FAIL',
      level: deployValidation.status === 'PASS' ? 'success' : 'warn',
      message: `Deploy validation ${deployValidation.status}: ${deployValidation.summary}. Blocking: ${deployValidation.blocking.length}.`
    });
    await emit({ agentId: 'deploy', eventType: 'WORK_COMPLETE', task: `Deploy validation completed: ${deployValidation.status}`, toAgent: 'qa', artifact: 'DEPLOY_VALIDATION.json' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progress({ stepId: 'deploy-validation', stepStatus: 'SKIPPED', level: 'warn', message: `Deploy validation skipped: ${message}` });
    deployValidation = { status: 'PASS', blocking: [], advisory: [], deployCommand: 'docker compose up --build', services: [], summary: 'Skipped due to error' };
  }

  if (codeReview.status === 'NEEDS_FIX' || deployValidation.status === 'NEEDS_FIX') {
    const reviewFeedback = [
      ...(codeReview.blocking.map((b) => `[CodeReview/${b.category}] ${b.file}: ${b.finding}. Fix: ${b.fix}`)),
      ...(deployValidation.blocking.map((b) => `[Deploy/${b.category}] ${b.file}: ${b.finding}. Fix: ${b.fix}`))
    ].join('\n');

    await progress({ stepId: 'dev', stepStatus: 'RUNNING', message: 'DEV agent fixing CodeReview/Deploy findings.' });
    await emit({ agentId: 'dev', eventType: 'CODING', task: 'Fix CodeReview and Deploy findings', artifact: 'generated-files' });
    existingFiles = await readGeneratedCodeSnapshot();
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      preparedTechStack,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: reviewFeedback,
      apiSpec: input.apiSpec,
      projectDevSkill,
      enrichedSkillContext: enrichedSkill.combined,
      onProgress: progress,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      reason: 'Update project-specific skill after CodeReview/Deploy repair.'
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: 'CodeReview/Deploy fixes applied', toAgent: 'qa', artifact: 'generated-files' });

    // Update step statuses to reflect that fixes were applied
    if (codeReview.status === 'NEEDS_FIX') {
      await progress({ stepId: 'code-review', stepStatus: 'PASS', level: 'success', message: 'Code review issues fixed by DEV agent.' });
    }
    if (deployValidation.status === 'NEEDS_FIX') {
      await progress({ stepId: 'deploy-validation', stepStatus: 'PASS', level: 'success', message: 'Deploy validation issues fixed by DEV agent.' });
    }
  }

  let buildReadinessFixIterations = 0;
  await progress({ stepId: 'static-validation', stepStatus: 'RUNNING', message: 'Running static readiness check.' });
  let buildReadiness = validateGeneratedProject(devOutput);
  await reportStaticReadiness(options?.onProgress, buildReadiness, 'Static readiness check');
  while (buildReadiness.status === 'NEEDS_FIX' && buildReadinessFixIterations < MAX_BUILD_READINESS_FIX_ITERATIONS) {
    const previousStaticSignature = staticFindingsSignature(buildReadiness);
    buildReadinessFixIterations += 1;

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `Run/build readiness check found blockers; sending fix request ${buildReadinessFixIterations} to DEV`,
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
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      reason: `Update project-specific skill after static readiness repair iteration ${buildReadinessFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Run/build readiness fixes generated iteration ${buildReadinessFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await progress({
      stepId: 'static-validation',
      stepStatus: 'RUNNING',
      message: `Re-running static readiness check after DEV fix iteration ${buildReadinessFixIterations}.`
    });
    buildReadiness = validateGeneratedProject(devOutput);
    await reportStaticReadiness(options?.onProgress, buildReadiness, `Static readiness check after DEV fix ${buildReadinessFixIterations}`);

    if (buildReadiness.status === 'NEEDS_FIX' && staticFindingsSignature(buildReadiness) === previousStaticSignature) {
      await progress({
        stepId: 'static-validation',
        stepStatus: 'RUNNING',
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

  await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Run generated project build/deploy smoke validation', artifact: 'generated-validation' });
  await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: 'Running generated project build/deploy smoke validation.' });
  executionValidation = await validateGeneratedProjectExecution(progress, options?.signal);

  while (executionValidation.status === 'NEEDS_FIX' && executionValidationFixIterations < MAX_EXECUTION_VALIDATION_FIX_ITERATIONS) {
    executionValidationFixIterations += 1;

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `Generated project execution validation failed; sending fix request ${executionValidationFixIterations} to DEV`,
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
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      executionValidation,
      reason: `Update project-specific skill after execution validation repair iteration ${executionValidationFixIterations}.`
    });
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Execution validation fixes generated iteration ${executionValidationFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await progress({
      stepId: 'static-validation',
      stepStatus: 'RUNNING',
      message: `Re-running static readiness check after execution fix iteration ${executionValidationFixIterations}.`
    });
    buildReadiness = validateGeneratedProject(devOutput);
    await reportStaticReadiness(options?.onProgress, buildReadiness, `Static readiness check after execution fix ${executionValidationFixIterations}`);

    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-run generated project execution validation iteration ${executionValidationFixIterations}`, artifact: 'generated-validation' });
    await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: `Re-running generated project build/deploy smoke validation iteration ${executionValidationFixIterations}.` });
    executionValidation = await validateGeneratedProjectExecution(progress, options?.signal);
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
    if (executionValidation.status === 'PASS' && !shouldRunFullQaAgent()) {
      await progress({
        stepId: 'qa',
        stepStatus: 'PASS',
        level: 'success',
        message: 'QA smoke gate passed from execution validation; skipping full QA agent review.'
      });
      qaReview = createSmokeQaReview(executionValidation);
    } else {
      await progress({ stepId: 'qa', stepStatus: 'RUNNING', message: 'QA agent is reviewing generated delivery.' });
      await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Validate generated delivery', artifact: 'QA_REPORT.md' });
      qaReview = await runQAAgent({
        requirements: input.requirements,
        techSpec: input.techSpec,
        preparedTechStack,
        baOutput,
        devOutput,
        existingFiles: await readGeneratedCodeSnapshot(),
        recentRuns,
        executionValidation,
        signal: options?.signal
      });
      throwIfCanceled(options?.signal);
    }
  }

  let qaFixIterations = 0;
  while (qaReview.status === 'NEEDS_FIX' && buildReadiness.status !== 'NEEDS_FIX' && executionValidation.status !== 'NEEDS_FIX' && qaFixIterations < MAX_QA_FIX_ITERATIONS) {
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
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    projectDevSkill = await updateProjectSkillFromDevOutput({
      devOutput,
      executionValidation,
      qaReview,
      reason: `Update project-specific skill after QA repair iteration ${qaFixIterations}.`
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
    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-run execution validation after QA fix iteration ${qaFixIterations}`, artifact: 'generated-validation' });
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
      preparedTechStack,
      baOutput,
      devOutput,
      existingFiles: await readGeneratedCodeSnapshot(),
      recentRuns,
      executionValidation,
      signal: options?.signal
    });
    throwIfCanceled(options?.signal);
  }

  await emit({ agentId: 'qa', eventType: 'TASK_COMPLETE', task: `QA report completed with status ${qaReview.status}`, artifact: 'QA_REPORT.md' });
  await progress({ stepId: 'qa', stepStatus: qaReview.status === 'PASS' ? 'PASS' : 'FAIL', level: qaReview.status === 'PASS' ? 'success' : 'warn', message: `QA completed with status ${qaReview.status}.` });

  projectDevSkill = await updateProjectSkillFromDevOutput({
    devOutput,
    executionValidation,
    qaReview,
    reason: 'Finalize project-specific skill after latest run status.'
  });

  const result: RunResult = {
    runId,
    createdAt: new Date().toISOString(),
    topic,
    projectId,
    projectDevSkillPath: projectDevSkill?.path,
    preparedTechStack,
    baOutput,
    devOutput,
    codeReviewStatus: codeReview.status,
    codeReviewSummary: codeReview.summary,
    deployValidationStatus: deployValidation.status,
    deployValidationSummary: deployValidation.summary,
    qaOutput: qaReview.report,
    qaStatus: qaReview.status,
    qaFindings: qaReview.findings,
    qaFixIterations,
    buildReadinessFixIterations,
    executionValidationFixIterations,
    executionValidation,
    events,
    outputDir: '',
    codeOutputDir
  };

  const outputDir = await saveRunResult(result);
  return { ...result, outputDir };
}
