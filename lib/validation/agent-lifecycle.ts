export interface AgentLifecycleValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
}

const REQUIRED_BA_SECTIONS = [
  'Product Summary',
  'Business Requirements',
  'Technical Requirements',
  'Features',
  'User Stories',
  'Constraints',
  'Selected Technology Stack',
  'Architecture Decisions',
  'Frontend Visual Design Contract',
  'Database Needs',
  'Authentication Needs',
  'API Architecture',
  'Frontend Needs',
  'Backend Needs',
  'Deployment Runtime Requirements',
  'Integrations',
  'Risks And Assumptions',
  'Implementation Plan',
  'Acceptance Criteria'
];

function hasHeading(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*(?:#{1,6}\\s+|\\d+\\.\\s*)${escaped}\\s*(\\n|$)`, 'i').test(markdown);
}

export function validateBaOutputStructure(baOutput: string): AgentLifecycleValidation {
  const findings = REQUIRED_BA_SECTIONS.filter((section) => !hasHeading(baOutput, section)).map((section) => `BA output is missing structured section: ${section}`);

  return {
    status: findings.length ? 'NEEDS_FIX' : 'PASS',
    findings
  };
}

const REQUIRED_TECH_STACK_KEYS = [
  'frontendFramework',
  'backendFramework',
  'database',
  'ormMigrationTool',
  'packageManager',
  'runtimeVersions',
  'dockerStrategy',
  'servicePorts',
  'environmentVariables',
  'projectArchitecture',
  'assumptions',
  'tradeoffs'
];

export function validatePreparedTechStackStructure(value: unknown): AgentLifecycleValidation {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const findings = record
    ? REQUIRED_TECH_STACK_KEYS.filter((key) => !(key in record)).map((key) => `prepare-tech-stack output is missing field: ${key}`)
    : ['prepare-tech-stack output is missing or invalid.'];

  return {
    status: findings.length ? 'NEEDS_FIX' : 'PASS',
    findings
  };
}
