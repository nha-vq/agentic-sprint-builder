import { emitDashboardEvent } from '@/lib/dashboard';
import { runBAAgent } from '@/lib/agents/ba-agent';
import { runDevAgent } from '@/lib/agents/dev-agent';
import { runQAAgent } from '@/lib/agents/qa-agent';
import { listRunResults, readGeneratedCodeSnapshot, saveRunResult, writeGeneratedFiles } from '@/lib/storage/file-writer';
import { validateGeneratedProject } from '@/lib/validation/generated-project';
import { validateGeneratedProjectExecution } from '@/lib/validation/generated-execution';
import { formatRepairScope, inferQaRepairScope, inferStaticRepairScope } from '@/lib/validation/repair-scope';
import { runGeneratedApp } from '@/lib/runtime/generated-app-runner';
import type { AgentEvent, DevOutput, GeneratedExecutionValidationResult, QAReviewOutput, RepairScope, RunProgressReporter, RunRequest, RunResult } from '@/lib/types';

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_QA_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_QA_FIX_ITERATIONS', 1);
const MAX_BUILD_READINESS_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_BUILD_READINESS_FIX_ITERATIONS', 1);
const MAX_EXECUTION_VALIDATION_FIX_ITERATIONS = readPositiveIntegerEnv('MAX_EXECUTION_VALIDATION_FIX_ITERATIONS', 2);

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

function formatExecutionValidationFeedback(validation: GeneratedExecutionValidationResult) {
  const steps = validation.steps
    .map((step) => {
      const command = step.command ? `\nCommand: ${step.command}` : '';
      const logFile = step.logFile ? `\nLog file: ${step.logFile}` : '';
      return `## ${step.name}\nStatus: ${step.status}${command}${logFile}\n${step.message}`;
    })
    .join('\n\n');

  return [
    `Execution validation status: ${validation.status}`,
    validation.findings.length ? `Findings:\n${validation.findings.map((finding) => `- ${finding}`).join('\n')}` : 'No findings.',
    formatRepairScope(validation.repairScope),
    'Validation steps:',
    steps
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

async function reportRepairScope(progress: RunProgressReporter | undefined, scope: RepairScope) {
  await progress?.({
    stepId: 'dev',
    stepStatus: 'RUNNING',
    level: 'info',
    message: `Scoped repair: ${scope.label}. Candidates: ${scope.candidatePaths.join(', ') || 'none detected'}. Directories: ${scope.allowedDirectories.join(', ')}`
  });
}

export async function runSprintBuilder(input: RunRequest, options?: { runId?: string; onProgress?: RunProgressReporter }): Promise<RunResult> {
  const runId = options?.runId || createTimestampRunId();
  const events: AgentEvent[] = [];
  const topic = input.topic || 'Simple Shopping Cart App';

  async function progress(update: Parameters<RunProgressReporter>[0]) {
    await options?.onProgress?.(update);
  }

  async function emit(params: Parameters<typeof emitDashboardEvent>[0]) {
    const event = await emitDashboardEvent(params);
    events.push(event);
    await progress({
      stepId: params.agentId === 'ba' ? 'ba' : params.agentId === 'qa' ? 'qa' : 'dev',
      level: params.eventType === 'ERROR' ? 'error' : params.eventType.includes('COMPLETE') ? 'success' : 'info',
      message: `${params.agentId.toUpperCase()} ${params.eventType}: ${params.task}`
    });
  }

  let existingFiles = await readGeneratedCodeSnapshot();
  const recentRuns = await listRunResults();

  await progress({ stepId: 'ba', stepStatus: 'RUNNING', message: 'BA agent is analyzing requirements.' });
  await emit({ agentId: 'ba', eventType: 'THINKING', task: 'Analyze requirements and scope', artifact: 'BA_ARTIFACTS.md' });
  const baOutput = await runBAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    existingFiles,
    recentRuns
  });
  await emit({ agentId: 'ba', eventType: 'WORK_COMPLETE', task: 'BA artifacts completed', toAgent: 'dev', artifact: 'BA_ARTIFACTS.md' });
  await progress({ stepId: 'ba', stepStatus: 'PASS', level: 'success', message: 'BA artifacts completed.' });

  await progress({ stepId: 'dev', stepStatus: 'RUNNING', message: 'DEV agent is generating implementation files.' });
  await emit({ agentId: 'dev', eventType: 'CODING', task: 'Generate implementation files', artifact: 'generated-files' });
  let devOutput = await runDevAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    existingFiles,
    recentRuns,
    apiSpec: input.apiSpec,
    onProgress: progress
  });
  let writeResult = await writeAndRefreshDevOutput(devOutput);
  devOutput = writeResult.devOutput;
  let codeOutputDir = writeResult.codeOutputDir;
  await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: 'Implementation files generated', toAgent: 'qa', artifact: 'generated-files' });

  let buildReadinessFixIterations = 0;
  let buildReadiness = validateGeneratedProject(devOutput);
  while (buildReadiness.status === 'NEEDS_FIX' && buildReadinessFixIterations < MAX_BUILD_READINESS_FIX_ITERATIONS) {
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
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: buildReadiness.fixInstructions,
      repairScope,
      apiSpec: input.apiSpec,
      onProgress: progress
    });
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    buildReadiness = validateGeneratedProject(devOutput);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Run/build readiness fixes generated iteration ${buildReadinessFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });
  }

  await progress({ stepId: 'static-validation', stepStatus: buildReadiness.status === 'PASS' ? 'PASS' : 'FAIL', level: buildReadiness.status === 'PASS' ? 'success' : 'warn', message: `Static readiness check ${buildReadiness.status}.` });
  await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Run generated project setup/build/test validation', artifact: 'generated-validation' });
  await progress({ stepId: 'execution-validation', stepStatus: 'RUNNING', message: 'Running generated project setup/build/test validation.' });
  let executionValidation = await validateGeneratedProjectExecution(progress);
  let executionValidationFixIterations = 0;

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
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix execution validation failures iteration ${executionValidationFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: formatExecutionValidationFeedback(executionValidation),
      repairScope,
      apiSpec: input.apiSpec,
      onProgress: progress
    });
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    buildReadiness = validateGeneratedProject(devOutput);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Execution validation fixes generated iteration ${executionValidationFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    if (buildReadiness.status === 'NEEDS_FIX') {
      await progress({
        stepId: 'static-validation',
        stepStatus: 'FAIL',
        level: 'warn',
        message: `Static readiness still has ${buildReadiness.findings.length} issue(s); re-running execution validation for the scoped runtime fix.`
      });
    }

    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-run generated project execution validation iteration ${executionValidationFixIterations}`, artifact: 'generated-validation' });
    executionValidation = await validateGeneratedProjectExecution(progress);
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

  await progress({ stepId: 'qa', stepStatus: 'RUNNING', message: 'QA agent is reviewing generated delivery.' });
  await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Validate generated delivery', artifact: 'QA_REPORT.md' });
  let qaReview: QAReviewOutput = await runQAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    devOutput,
    existingFiles: await readGeneratedCodeSnapshot(),
    recentRuns,
    executionValidation
  });

  let qaFixIterations = 0;
  while (qaReview.status === 'NEEDS_FIX' && qaFixIterations < MAX_QA_FIX_ITERATIONS) {
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
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback,
      repairScope,
      apiSpec: input.apiSpec,
      onProgress: progress
    });
    writeResult = await writeAndRefreshDevOutput(devOutput);
    devOutput = writeResult.devOutput;
    codeOutputDir = writeResult.codeOutputDir;
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `QA fixes generated iteration ${qaFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-validate delivery iteration ${qaFixIterations}`, artifact: 'QA_REPORT.md' });
    qaReview = await runQAAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      devOutput,
      existingFiles: await readGeneratedCodeSnapshot(),
      recentRuns,
      executionValidation
    });
  }

  await emit({ agentId: 'qa', eventType: 'TASK_COMPLETE', task: `QA report completed with status ${qaReview.status}`, artifact: 'QA_REPORT.md' });
  await progress({ stepId: 'qa', stepStatus: qaReview.status === 'PASS' ? 'PASS' : 'FAIL', level: qaReview.status === 'PASS' ? 'success' : 'warn', message: `QA completed with status ${qaReview.status}.` });
  const hasBlockingIssues = executionValidation.status === 'NEEDS_FIX' || qaReview.status === 'NEEDS_FIX';
  const runtime = hasBlockingIssues
    ? {
        startedAt: new Date().toISOString(),
        services: [
          {
            name: 'backend' as const,
            status: 'SKIPPED' as const,
            cwd: codeOutputDir,
            command: '',
            message: 'Skipped local runtime because validation or QA still has blocking issues.'
          },
          {
            name: 'frontend' as const,
            status: 'SKIPPED' as const,
            cwd: codeOutputDir,
            command: '',
            message: 'Skipped local runtime because validation or QA still has blocking issues.'
          }
        ]
      }
    : await (async () => {
        await progress({ stepId: 'runtime', stepStatus: 'RUNNING', message: 'Starting generated app runtime.' });
        await emit({ agentId: 'dev', eventType: 'WORKING', task: 'Start generated backend and frontend locally', artifact: 'generated-runtime' });
        return runGeneratedApp(progress);
      })();

  if (hasBlockingIssues) {
    await progress({
      stepId: 'runtime',
      stepStatus: 'SKIPPED',
      level: 'warn',
      message: 'Skipped local runtime because validation or QA still has blocking issues.'
    });
  } else {
    const failedServices = runtime.services.filter((service) => service.status === 'FAILED');
    await emit({
      agentId: 'dev',
      eventType: failedServices.length > 0 ? 'ERROR' : 'WORK_COMPLETE',
      task:
        failedServices.length > 0
          ? `Generated app runtime started with failures: ${failedServices.map((service) => service.name).join(', ')}`
          : 'Generated backend and frontend runtime started',
      artifact: 'generated-runtime'
    });
    await progress({
      stepId: 'runtime',
      stepStatus: failedServices.length > 0 ? 'FAIL' : 'PASS',
      level: failedServices.length > 0 ? 'warn' : 'success',
      message: failedServices.length > 0 ? `Runtime started with failures: ${failedServices.map((service) => service.name).join(', ')}.` : 'Generated runtime started.'
    });
  }

  const result: RunResult = {
    runId,
    createdAt: new Date().toISOString(),
    topic,
    baOutput,
    devOutput,
    qaOutput: qaReview.report,
    qaStatus: qaReview.status,
    qaFindings: qaReview.findings,
    qaFixIterations,
    buildReadinessFixIterations,
    executionValidationFixIterations,
    executionValidation,
    runtime,
    events,
    outputDir: '',
    codeOutputDir
  };

  const outputDir = await saveRunResult(result);
  return { ...result, outputDir };
}
