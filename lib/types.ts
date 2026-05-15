export type AgentId = 'ba' | 'dev' | 'qa';

export type DashboardEventType =
  | 'THINKING'
  | 'WORKING'
  | 'CODING'
  | 'REVIEWING'
  | 'WORK_COMPLETE'
  | 'REVIEW_REQUEST'
  | 'TASK_COMPLETE'
  | 'ERROR'
  | 'IDLE';

export interface AgentEvent {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  timestamp: string;
  dashboardAccepted?: boolean;
}

export interface RunRequest {
  requirements: string;
  techSpec?: string | null;
  apiSpec?: string;
  topic?: string;
}

export type RunJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type RunProgressStepStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'SKIPPED';
export type RunProgressLogLevel = 'info' | 'success' | 'warn' | 'error';

export interface RunProgressStep {
  id: string;
  label: string;
  status: RunProgressStepStatus;
}

export interface RunProgressLogEntry {
  timestamp: string;
  level: RunProgressLogLevel;
  message: string;
}

export interface RunProgressUpdate {
  stepId?: string;
  stepLabel?: string;
  stepStatus?: RunProgressStepStatus;
  level?: RunProgressLogLevel;
  message: string;
}

export type RunProgressReporter = (update: RunProgressUpdate) => void | Promise<void>;

export interface RunStatusSnapshot {
  runId: string;
  status: RunJobStatus;
  createdAt: string;
  updatedAt: string;
  topic: string;
  currentStepId?: string;
  steps: RunProgressStep[];
  logs: RunProgressLogEntry[];
  result?: RunResult;
  error?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface DevOutput {
  architecture: string;
  files: GeneratedFile[];
  setupInstructions: string;
}

export type RepairScopeKind = 'initial' | 'docker' | 'frontend' | 'backend' | 'database' | 'tests' | 'docs' | 'config' | 'unknown';

export interface RepairScope {
  kind: RepairScopeKind;
  label: string;
  instructions: string;
  candidatePaths: string[];
  allowedDirectories: string[];
  requiresPlanning?: boolean;
}

export type QAStatus = 'PASS' | 'NEEDS_FIX';

export interface QAReviewOutput {
  status: QAStatus;
  findings: string[];
  fixInstructions: string;
  report: string;
}

export type GeneratedRuntimeServiceStatus = 'RUNNING' | 'FAILED' | 'SKIPPED';

export interface GeneratedRuntimeServiceResult {
  name: 'backend' | 'frontend';
  status: GeneratedRuntimeServiceStatus;
  cwd: string;
  command: string;
  url?: string;
  port?: number;
  pid?: number;
  logFile?: string;
  message: string;
}

export interface GeneratedRuntimeResult {
  startedAt: string;
  services: GeneratedRuntimeServiceResult[];
}

export type GeneratedValidationStatus = 'PASS' | 'NEEDS_FIX' | 'SKIPPED';
export type GeneratedValidationStepStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface GeneratedValidationStep {
  name: string;
  status: GeneratedValidationStepStatus;
  command?: string;
  message: string;
  logFile?: string;
}

export interface GeneratedExecutionValidationResult {
  status: GeneratedValidationStatus;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  findings: string[];
  fixInstructions: string;
  repairScope?: RepairScope;
  steps: GeneratedValidationStep[];
}

export interface RunResult {
  runId: string;
  createdAt: string;
  topic: string;
  baOutput: string;
  devOutput: DevOutput;
  qaOutput: string;
  qaStatus?: QAStatus;
  qaFindings?: string[];
  qaFixIterations?: number;
  buildReadinessFixIterations?: number;
  executionValidationFixIterations?: number;
  executionValidation?: GeneratedExecutionValidationResult;
  runtime?: GeneratedRuntimeResult;
  events: AgentEvent[];
  outputDir: string;
  codeOutputDir: string;
}
