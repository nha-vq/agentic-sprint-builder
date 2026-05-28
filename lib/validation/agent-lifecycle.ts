import type { PreparedTechStackOutput } from '@/lib/types';

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
  'devSkillGuidance',
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

const EXPLICIT_TECH_SPEC_CHECKS: Array<{
  label: string;
  pattern: RegExp;
  fields: Array<keyof PreparedTechStackOutput>;
  selectedPattern: RegExp;
}> = [
  { label: 'Next.js', pattern: /\bnext(?:\.js|js)?\b/i, fields: ['frontendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bnext(?:\.js|js)?\b/i },
  { label: 'Tailwind CSS', pattern: /\btailwind\b/i, fields: ['frontendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\btailwind\b/i },
  { label: 'React', pattern: /\breact\b/i, fields: ['frontendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\breact\b/i },
  { label: 'Vue', pattern: /\bvue(?:\.js|js)?\b/i, fields: ['frontendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bvue(?:\.js|js)?\b/i },
  { label: 'Angular', pattern: /\bangular\b/i, fields: ['frontendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bangular\b/i },
  { label: 'FastAPI', pattern: /\bfast\s*api\b|\bfastapi\b/i, fields: ['backendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bfast\s*api\b|\bfastapi\b/i },
  { label: 'SQLModel', pattern: /\bsqlmodel\b/i, fields: ['backendFramework', 'ormMigrationTool', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bsqlmodel\b/i },
  { label: 'Spring Boot', pattern: /\bspring\s*boot\b/i, fields: ['backendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bspring\s*boot\b/i },
  { label: 'Django', pattern: /\bdjango\b/i, fields: ['backendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bdjango\b/i },
  { label: 'Express', pattern: /\bexpress(?:\.js|js)?\b/i, fields: ['backendFramework', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bexpress(?:\.js|js)?\b/i },
  { label: 'SQLite', pattern: /\bsqlite\b/i, fields: ['database', 'ormMigrationTool', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bsqlite\b/i },
  { label: 'PostgreSQL', pattern: /\bpostgres(?:ql)?\b/i, fields: ['database', 'ormMigrationTool', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bpostgres(?:ql)?\b/i },
  { label: 'MySQL', pattern: /\bmysql\b/i, fields: ['database', 'ormMigrationTool', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bmysql\b/i },
  { label: 'MongoDB', pattern: /\bmongodb\b|\bmongo\b/i, fields: ['database', 'ormMigrationTool', 'projectArchitecture', 'devSkillGuidance'], selectedPattern: /\bmongodb\b|\bmongo\b/i }
];

function fieldText(output: PreparedTechStackOutput, fields: Array<keyof PreparedTechStackOutput>) {
  return fields
    .map((field) => output[field])
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value ?? '')))
    .join('\n');
}

export function validatePreparedTechStackAlignment(techSpec: string | null | undefined, output: PreparedTechStackOutput): AgentLifecycleValidation {
  const text = techSpec?.trim() ?? '';
  if (!text || /^not provided\.?$/i.test(text)) {
    return { status: 'PASS', findings: [] };
  }

  const findings = EXPLICIT_TECH_SPEC_CHECKS.filter((check) => check.pattern.test(text) && !check.selectedPattern.test(fieldText(output, check.fields))).map(
    (check) =>
      `prepare-tech-stack selected ${output.frontendFramework} / ${output.backendFramework} / ${output.database}, but the user tech spec explicitly requires ${check.label}. Existing generated code or run history must not override explicit stack choices.`
  );

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings
  };
}
