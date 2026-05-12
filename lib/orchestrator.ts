import { emitDashboardEvent } from '@/lib/dashboard';
import { runBAAgent } from '@/lib/agents/ba-agent';
import { runDevAgent } from '@/lib/agents/dev-agent';
import { runQAAgent } from '@/lib/agents/qa-agent';
import { listRunResults, readGeneratedCodeSnapshot, saveRunResult, writeGeneratedFiles } from '@/lib/storage/file-writer';
import { validateGeneratedProject } from '@/lib/validation/generated-project';
import type { AgentEvent, QAReviewOutput, RunRequest, RunResult } from '@/lib/types';

const MAX_QA_FIX_ITERATIONS = 1;
const MAX_BUILD_READINESS_FIX_ITERATIONS = 1;

function createTimestampRunId(date = new Date()) {
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

export async function runSprintBuilder(input: RunRequest): Promise<RunResult> {
  const runId = createTimestampRunId();
  const events: AgentEvent[] = [];
  const topic = input.topic || 'Simple Shopping Cart App';

  async function emit(params: Parameters<typeof emitDashboardEvent>[0]) {
    const event = await emitDashboardEvent(params);
    events.push(event);
  }

  let existingFiles = await readGeneratedCodeSnapshot();
  const recentRuns = await listRunResults();

  await emit({ agentId: 'ba', eventType: 'THINKING', task: 'Analyze requirements and scope', artifact: 'BA_ARTIFACTS.md' });
  const baOutput = await runBAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    existingFiles,
    recentRuns
  });
  await emit({ agentId: 'ba', eventType: 'WORK_COMPLETE', task: 'BA artifacts completed', toAgent: 'dev', artifact: 'BA_ARTIFACTS.md' });

  await emit({ agentId: 'dev', eventType: 'CODING', task: 'Generate implementation files', artifact: 'generated-files' });
  let devOutput = await runDevAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    existingFiles,
    recentRuns,
    apiSpec: input.apiSpec
  });
  let codeOutputDir = await writeGeneratedFiles(devOutput.files);
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
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix run/build readiness blockers iteration ${buildReadinessFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: buildReadiness.fixInstructions,
      apiSpec: input.apiSpec
    });
    codeOutputDir = await writeGeneratedFiles(devOutput.files);
    buildReadiness = validateGeneratedProject(devOutput);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Run/build readiness fixes generated iteration ${buildReadinessFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });
  }

  await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Validate generated delivery', artifact: 'QA_REPORT.md' });
  let qaReview: QAReviewOutput = await runQAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    devOutput,
    existingFiles: await readGeneratedCodeSnapshot(),
    recentRuns
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
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix QA findings iteration ${qaFixIterations}`, artifact: 'generated-files' });
    devOutput = await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      existingFiles,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: `${qaReview.fixInstructions}\n\nFindings:\n${qaReview.findings.join('\n')}\n\nReport:\n${qaReview.report}`,
      apiSpec: input.apiSpec
    });
    codeOutputDir = await writeGeneratedFiles(devOutput.files);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `QA fixes generated iteration ${qaFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-validate delivery iteration ${qaFixIterations}`, artifact: 'QA_REPORT.md' });
    qaReview = await runQAAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      devOutput,
      existingFiles: await readGeneratedCodeSnapshot(),
      recentRuns
    });
  }

  await emit({ agentId: 'qa', eventType: 'TASK_COMPLETE', task: `QA report completed with status ${qaReview.status}`, artifact: 'QA_REPORT.md' });

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
    events,
    outputDir: '',
    codeOutputDir
  };

  const outputDir = await saveRunResult(result);
  return { ...result, outputDir };
}
