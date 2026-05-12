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

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface DevOutput {
  architecture: string;
  files: GeneratedFile[];
  setupInstructions: string;
}

export type QAStatus = 'PASS' | 'NEEDS_FIX';

export interface QAReviewOutput {
  status: QAStatus;
  findings: string[];
  fixInstructions: string;
  report: string;
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
  events: AgentEvent[];
  outputDir: string;
  codeOutputDir: string;
}
