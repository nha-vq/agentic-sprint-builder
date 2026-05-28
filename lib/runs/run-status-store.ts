import type { RunProgressStep, RunProgressUpdate, RunResult, RunStatusSnapshot } from '@/lib/types';

const MAX_LOGS = 500;

const DEFAULT_STEPS: RunProgressStep[] = [
  { id: 'ba', label: 'BA analysis', status: 'PENDING' },
  { id: 'tech-stack', label: 'Tech stack prep', status: 'PENDING' },
  { id: 'ux', label: 'UX contract', status: 'PENDING' },
  { id: 'dev', label: 'DEV lead', status: 'PENDING' },
  { id: 'frontend-dev', label: 'Frontend DEV', status: 'PENDING' },
  { id: 'backend-dev', label: 'Backend DEV', status: 'PENDING' },
  { id: 'integration-dev', label: 'Integration DEV', status: 'PENDING' },
  { id: 'code-review', label: 'Code review', status: 'PENDING' },
  { id: 'deploy-validation', label: 'Deploy validation', status: 'PENDING' },
  { id: 'static-validation', label: 'Static readiness', status: 'PENDING' },
  { id: 'execution-validation', label: 'Deploy smoke validation', status: 'PENDING' },
  { id: 'qa', label: 'QA review', status: 'PENDING' },
  { id: 'complete', label: 'Done', status: 'PENDING' }
];

const globalForRuns = globalThis as typeof globalThis & {
  __agenticSprintRuns?: Map<string, RunStatusSnapshot>;
  __agenticSprintRunControllers?: Map<string, AbortController>;
};

const runs = globalForRuns.__agenticSprintRuns ?? new Map<string, RunStatusSnapshot>();
globalForRuns.__agenticSprintRuns = runs;
const controllers = globalForRuns.__agenticSprintRunControllers ?? new Map<string, AbortController>();
globalForRuns.__agenticSprintRunControllers = controllers;

function now() {
  return new Date().toISOString();
}

function cloneSteps() {
  return DEFAULT_STEPS.map((step) => ({ ...step }));
}

function ensureStep(snapshot: RunStatusSnapshot, stepId: string, label?: string) {
  let step = snapshot.steps.find((item) => item.id === stepId);
  if (!step) {
    step = { id: stepId, label: label || stepId, status: 'PENDING' };
    snapshot.steps.push(step);
  }

  if (label) step.label = label;
  return step;
}

function appendLog(snapshot: RunStatusSnapshot, update: RunProgressUpdate) {
  snapshot.logs.push({
    timestamp: now(),
    level: update.level || 'info',
    message: update.message
  });

  if (snapshot.logs.length > MAX_LOGS) {
    snapshot.logs.splice(0, snapshot.logs.length - MAX_LOGS);
  }
}

export function createRunStatus(runId: string, topic: string) {
  const timestamp = now();
  const snapshot: RunStatusSnapshot = {
    runId,
    status: 'QUEUED',
    createdAt: timestamp,
    updatedAt: timestamp,
    topic,
    steps: cloneSteps(),
    logs: [
      {
        timestamp,
        level: 'info',
        message: 'Run queued.'
      }
    ]
  };

  runs.set(runId, snapshot);
  return snapshot;
}

export function updateRunProgress(runId: string, update: RunProgressUpdate) {
  const snapshot = runs.get(runId);
  if (!snapshot) return null;
  if (snapshot.status === 'CANCELED') return snapshot;

  snapshot.status = snapshot.status === 'QUEUED' ? 'RUNNING' : snapshot.status;
  snapshot.updatedAt = now();

  if (update.stepId) {
    const step = ensureStep(snapshot, update.stepId, update.stepLabel);
    if (update.stepStatus) step.status = update.stepStatus;
    snapshot.currentStepId = update.stepId;
  }

  appendLog(snapshot, update);
  return snapshot;
}

export function completeRunStatus(runId: string, result: RunResult) {
  const snapshot = runs.get(runId) ?? createRunStatus(runId, result.topic);
  if (snapshot.status === 'CANCELED') return snapshot;
  const hasBlockingIssues =
    result.executionValidation?.status === 'NEEDS_FIX' ||
    result.qaStatus === 'NEEDS_FIX' ||
    result.deployValidationStatus === 'NEEDS_FIX' ||
    result.codeReviewStatus === 'NEEDS_FIX';

  snapshot.status = 'COMPLETED';
  snapshot.updatedAt = now();
  snapshot.result = result;
  snapshot.currentStepId = 'complete';
  ensureStep(snapshot, 'complete').status = hasBlockingIssues ? 'FAIL' : 'PASS';
  appendLog(snapshot, {
    stepId: 'complete',
    stepStatus: hasBlockingIssues ? 'FAIL' : 'PASS',
    level: hasBlockingIssues ? 'warn' : 'success',
    message: hasBlockingIssues ? 'Run finished with blocking issues. Check failed steps above.' : 'Run completed.'
  });
  return snapshot;
}

export function failRunStatus(runId: string, error: unknown) {
  const snapshot = runs.get(runId);
  if (!snapshot) return null;
  if (snapshot.status === 'CANCELED') return snapshot;

  const message = error instanceof Error ? error.message : String(error);
  snapshot.status = 'FAILED';
  snapshot.updatedAt = now();
  snapshot.error = message;

  if (snapshot.currentStepId) {
    ensureStep(snapshot, snapshot.currentStepId).status = 'FAIL';
  }

  appendLog(snapshot, {
    stepId: snapshot.currentStepId,
    stepStatus: 'FAIL',
    level: 'error',
    message
  });

  return snapshot;
}

export function registerRunController(runId: string, controller: AbortController) {
  controllers.set(runId, controller);
}

export function clearRunController(runId: string) {
  controllers.delete(runId);
}

export function cancelRunStatus(runId: string) {
  const snapshot = runs.get(runId);
  if (!snapshot) return null;

  controllers.get(runId)?.abort('Run canceled by user.');
  controllers.delete(runId);

  snapshot.status = 'CANCELED';
  snapshot.updatedAt = now();
  if (snapshot.currentStepId) {
    ensureStep(snapshot, snapshot.currentStepId).status = 'SKIPPED';
  }
  ensureStep(snapshot, 'complete').status = 'SKIPPED';
  appendLog(snapshot, {
    stepId: snapshot.currentStepId || 'complete',
    stepStatus: 'SKIPPED',
    level: 'warn',
    message: 'Run canceled by user.'
  });

  return snapshot;
}

export function isRunCanceled(runId: string) {
  return runs.get(runId)?.status === 'CANCELED' || controllers.get(runId)?.signal.aborted === true;
}

export function getRunStatus(runId: string) {
  return runs.get(runId) ?? null;
}
