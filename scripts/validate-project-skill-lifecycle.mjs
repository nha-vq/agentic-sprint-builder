import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(filePath, needle, message) {
  const content = read(filePath);
  if (!content.includes(needle)) {
    throw new Error(`${message}\nMissing in ${filePath}: ${needle}`);
  }
}

function assertMatches(filePath, pattern, message) {
  const content = read(filePath);
  if (!pattern.test(content)) {
    throw new Error(`${message}\nPattern not found in ${filePath}: ${pattern}`);
  }
}

function assertPathExists(relativePath, message) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    throw new Error(`${message}\nMissing path: ${relativePath}`);
  }
}

for (const folder of ['.github/rules', '.github/skills']) {
  assertPathExists(folder, `Taskflow-style .github folder must exist: ${folder}`);
}

const requiredBaSections = [
  'Business Requirements',
  'Technical Requirements',
  'Features',
  'Selected Technology Stack',
  'Architecture Decisions',
  'Database Needs',
  'Authentication Needs',
  'API Architecture',
  'Frontend Needs',
  'Backend Needs',
  'Deployment Runtime Requirements',
  'Implementation Plan',
  'Acceptance Criteria'
];

for (const section of requiredBaSections) {
  assertIncludes('.github/skills/ba/SKILL.md', section, `BA skill must require structured ${section} output.`);
}

assertIncludes('lib/skills/project-dev-skill.ts', 'writeProjectDevSkill', 'Project-specific skill writer must exist.');
assertIncludes('lib/skills/project-dev-skill.ts', 'loadProjectDevSkill', 'Project-specific skill loader must exist.');
assertIncludes('lib/skills/project-dev-skill.ts', 'project-skills', 'Project-specific skills must be saved under project-skills/.');
assertIncludes('lib/skills/project-dev-skill.ts', 'project-dev-template.md', 'Project-specific skill writer must load a markdown template.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Prepare Tech Stack Skill', 'prepare-tech-stack skill must exist.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'frontend framework', 'prepare-tech-stack skill must decide frontend framework.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'backend framework', 'prepare-tech-stack skill must decide backend framework.');
assertIncludes('.github/skills/tech-stack/SKILL.md', 'Docker strategy', 'prepare-tech-stack skill must decide Docker strategy.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Actual Tech Stack', 'Generated project skill template must record tech stack.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Future Feature Rules', 'Generated project skill template must include future feature rules.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', 'Requirement Context', 'Generated project skill template must reuse requirement-context flow.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', 'Task Context', 'Generated project skill template must reuse task-context flow.');
assertIncludes('.github/skills/project-dev-template/SKILL.md', '## Prepared Tech Stack', 'Generated project skill template must include prepared tech stack.');

assertIncludes('lib/agents/base-agent.ts', 'systemAppend', 'Base agent must support appended project-specific skill context.');
assertIncludes('lib/agents/tech-stack-agent.ts', 'runPrepareTechStackAgent', 'Tech stack agent runner must exist.');
assertIncludes('lib/types.ts', "'tech-stack'", 'AgentId must include tech-stack.');
assertIncludes('lib/agents/dev-agent.ts', 'projectDevSkill', 'DEV agent must accept project-specific skill context.');
assertIncludes('lib/agents/dev-agent.ts', 'buildDevSystemAppend', 'DEV OpenRouter calls must append project/prepared skill context.');
assertIncludes('lib/agents/dev-agent.ts', 'PREPARED TECH STACK', 'DEV context must include prepared tech stack.');

assertIncludes('lib/orchestrator.ts', 'loadProjectDevSkill', 'Orchestrator must load a project-specific skill.');
assertIncludes('lib/orchestrator.ts', 'writeProjectDevSkill', 'Orchestrator must write/update a project-specific skill.');
assertIncludes('lib/orchestrator.ts', 'runPrepareTechStackAgent', 'Orchestrator must run prepare-tech-stack.');
assertIncludes('lib/orchestrator.ts', 'Create project-specific skill after first generated-code scaffold.', 'First scaffold must create the project-specific skill.');
assertMatches('lib/orchestrator.ts', /runDevAgent\(\{[\s\S]*projectDevSkill/s, 'Orchestrator must pass project-specific skill to DEV agent.');

const orchestrator = read('lib/orchestrator.ts');
const baIndex = orchestrator.indexOf('const baOutput = await runBAAgent');
const techStackIndex = orchestrator.indexOf('const preparedTechStack');
const firstDevIndex = orchestrator.indexOf('let devOutput = await runDevAgent');
const firstProjectSkillUpdateIndex = orchestrator.indexOf('projectDevSkill = await updateProjectSkillFromDevOutput');
if (!(baIndex >= 0 && techStackIndex > baIndex && firstDevIndex > techStackIndex)) {
  throw new Error('Orchestrator must enforce BA -> prepare-tech-stack -> DEV order.');
}
if (!(firstProjectSkillUpdateIndex > techStackIndex)) {
  throw new Error('Orchestrator must not update project-specific DEV skill before prepare-tech-stack completes.');
}

assertIncludes('lib/validation/agent-lifecycle.ts', 'validateBaOutputStructure', 'Lifecycle validation must validate BA structured output.');
assertIncludes('lib/validation/agent-lifecycle.ts', 'validatePreparedTechStackStructure', 'Lifecycle validation must validate prepare-tech-stack output.');
assertIncludes('app/api/runs/route.ts', 'projectId', 'Run API must accept projectId for skill selection.');

assertIncludes('lib/agents/code-review-agent.ts', 'runCodeReviewAgent', 'CodeReview agent runner must exist.');
assertIncludes('lib/agents/deploy-agent.ts', 'runDeployAgent', 'Deploy agent runner must exist.');
assertIncludes('lib/orchestrator.ts', 'runCodeReviewAgent', 'Orchestrator must run CodeReview agent.');
assertIncludes('lib/orchestrator.ts', 'runDeployAgent', 'Orchestrator must run Deploy agent.');
assertIncludes('lib/orchestrator.ts', 'enrichSkillContext', 'Orchestrator must enrich skill context from tech stack.');
assertIncludes('lib/types.ts', "'code-review'", 'AgentId must include code-review.');
assertIncludes('lib/types.ts', "'deploy'", 'AgentId must include deploy.');

console.log('Project skill lifecycle validation passed.');
