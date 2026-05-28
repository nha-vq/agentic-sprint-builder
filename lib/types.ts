export type AgentId =
  | 'ba'
  | 'tech-stack'
  | 'ux'
  | 'dev'
  | 'frontend-dev'
  | 'backend-dev'
  | 'integration-dev'
  | 'code-review'
  | 'deploy'
  | 'qa';

export type AgentModelMap = Partial<Record<AgentId, string>>;

export type DashboardEventType =
  | 'THINKING'
  | 'WORKING'
  | 'CODING'
  | 'EXECUTING'
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
  dashboardAgentId?: string;
  dashboardToAgentId?: string;
  dashboardAccepted?: boolean;
  dashboardStatus?: number;
  dashboardPath?: string;
  dashboardError?: string;
  dashboardResponse?: string;
}

export interface RequirementImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  dataUrl: string;
}

export type RequirementImageMetadata = Omit<RequirementImage, 'dataUrl'>;

export interface FreeImageCandidate {
  title: string;
  pageUrl: string;
  imageUrl: string;
  thumbUrl?: string;
  license: string;
  licenseUrl?: string;
  source: 'Wikimedia Commons' | 'Openverse';
  query: string;
}

export interface PreparedMediaAsset {
  title: string;
  path: string;
  publicUrl: string;
  sourceImageUrl: string;
  sourcePageUrl: string;
  downloadUrl: string;
  license: string;
  licenseUrl?: string;
  query: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
}

export interface RunRequest {
  requirements: string;
  techSpec?: string | null;
  apiSpec?: string;
  topic?: string;
  projectId?: string;
  requirementImages?: RequirementImage[] | null;
  agentModels?: AgentModelMap | null;
}

export type RunJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED';
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

export interface LlmUsageRecord {
  agentId: AgentId;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: string;
  responseId?: string;
}

export interface LlmCostBreakdown {
  id: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface RunCostSummary {
  totalUsd: number;
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byAgent: LlmCostBreakdown[];
  byModel: LlmCostBreakdown[];
}

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

export type ProjectSpecKind = 'requirements' | 'ux' | 'architecture' | 'implementation' | 'validation';

export interface ProjectSpecArtifact {
  kind: ProjectSpecKind;
  title: string;
  path: string;
  content: string;
}

export interface DevOutput {
  architecture: string;
  files: GeneratedFile[];
  setupInstructions: string;
}

export interface PreparedTechStackOutput {
  frontendFramework: string;
  backendFramework: string;
  database: string;
  ormMigrationTool: string;
  packageManager: string;
  runtimeVersions: Array<{
    name: string;
    version: string;
    notes?: string;
  }>;
  dockerStrategy: string;
  servicePorts: Array<{
    service: string;
    hostPort: number;
    containerPort: number;
    protocol: string;
  }>;
  environmentVariables: Array<{
    name: string;
    service: string;
    purpose: string;
    example: string;
    required: boolean;
  }>;
  projectArchitecture: string;
  devSkillGuidance?: string;
  assumptions: string[];
  tradeoffs: string[];
}

export interface UXContractOutput {
  summary: string;
  informationArchitecture: string;
  layoutContract: string;
  componentInventory: string[];
  visualDesignTokens: string;
  imageTreatment: string;
  responsiveRules: string;
  interactionRules: string;
  consistencyRules: string[];
  devHandoffChecklist: string[];
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

export type VisualComparisonStatus = 'PASS' | 'NEEDS_REVIEW' | 'NEEDS_FIX' | 'SKIPPED';

export interface VisualComparisonImage {
  label: string;
  name: string;
  assetPath: string;
  sourcePath?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
}

export interface VisualComparisonResult {
  status: VisualComparisonStatus;
  score: number;
  reportPath: string;
  reportUrl: string;
  mockups: VisualComparisonImage[];
  screenshots: VisualComparisonImage[];
  findings: string[];
  recommendations: string[];
}

export interface RunResult {
  runId: string;
  createdAt: string;
  topic: string;
  projectId?: string;
  projectDevContextPath?: string;
  /** @deprecated Use projectDevContextPath. Kept for older saved run compatibility. */
  projectDevSkillPath?: string;
  preparedTechStack?: PreparedTechStackOutput;
  uxContract?: UXContractOutput;
  baOutput: string;
  devOutput: DevOutput;
  codeReviewStatus?: 'PASS' | 'NEEDS_FIX';
  codeReviewSummary?: string;
  codeReviewFixIterations?: number;
  deployValidationStatus?: 'PASS' | 'NEEDS_FIX';
  deployValidationSummary?: string;
  deployFixIterations?: number;
  qaOutput: string;
  qaStatus?: QAStatus;
  qaFindings?: string[];
  qaFixIterations?: number;
  buildReadinessFixIterations?: number;
  executionValidationFixIterations?: number;
  executionValidation?: GeneratedExecutionValidationResult;
  runtime?: GeneratedRuntimeResult;
  freeImageCandidates?: FreeImageCandidate[];
  preparedMediaAssets?: PreparedMediaAsset[];
  agentModels?: AgentModelMap;
  llmUsage?: LlmUsageRecord[];
  costSummary?: RunCostSummary;
  costBudgetUsd?: number;
  costBudgetExceeded?: boolean;
  costControlNotes?: string[];
  specArtifacts?: ProjectSpecArtifact[];
  observationReportPath?: string;
  observationReportUrl?: string;
  visualComparison?: VisualComparisonResult;
  events: AgentEvent[];
  outputDir: string;
  codeOutputDir: string;
}
