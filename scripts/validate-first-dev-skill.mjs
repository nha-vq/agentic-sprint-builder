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

function assertNotMatches(filePath, pattern, message) {
  const content = read(filePath);
  if (pattern.test(content)) {
    throw new Error(`${message}\nMatched in ${filePath}: ${pattern}`);
  }
}

function firstGenerationContract() {
  const content = read('.github/skills/dev/SKILL.md');
  const marker = '## Machine-Readable First Generation Contract';
  const index = content.indexOf(marker);
  if (index < 0) throw new Error(`Missing ${marker} in .github/skills/dev/SKILL.md.`);

  const match = content.slice(index).match(/```json\s*([\s\S]*?)```/i);
  if (!match) throw new Error('Missing JSON contract block in .github/skills/dev/SKILL.md.');
  return JSON.parse(match[1]);
}

const devSkill = '.github/skills/dev/SKILL.md';

for (const phrase of [
  'First Generation BA Handoff',
  'business requirements',
  'technical requirements',
  'UI Requirements',
  'Backend Requirements',
  'Database Needs',
  'Authentication Requirements',
  'API Requirements',
  'Deployment/Runtime Requirements',
  'Requirement-To-Skill Flow',
  'Internal First-Generation Planning Template',
  'Shared Contracts',
  'Task Context',
  `First Generation ${'3-' + 'Container'} Full-Stack Contract`,
  'Frontend container requirements',
  'Backend container requirements',
  'Database container requirements',
  'Machine-Readable First Generation Contract',
  'Do not generate package lockfiles'
]) {
  assertIncludes(devSkill, phrase, `Overall first DEV skill must explicitly cover ${phrase}.`);
}

const contract = firstGenerationContract();

for (const requiredPath of ['README.md', '.env.example', 'docker-compose.yml']) {
  if (!contract.requiredPaths?.includes(requiredPath)) {
    throw new Error(`DEV skill contract must require ${requiredPath}.`);
  }
}

for (const directory of ['frontend', 'backend']) {
  if (!contract.requiredTopLevelDirectories?.includes(directory)) {
    throw new Error(`DEV skill contract must require ${directory}/.`);
  }
}

if (!contract.oneOfTopLevelDirectories?.some((group) => group.includes('database') && group.includes('db'))) {
  throw new Error('DEV skill contract must require database/ or db/.');
}

const devAgent = 'lib/agents/dev-agent.ts';
for (const phrase of [
  'Use the loaded DEV skill as the source of generation behavior',
  'Application source only provides context',
  'Plan all files required by the loaded DEV skill',
  'BA OUTPUT:',
  'REQUIREMENTS:',
  'TECH SPEC:',
  'OversizedGeneratedFileError',
  'assertGeneratedFileWithinLimit'
]) {
  assertIncludes(devAgent, phrase, `DEV runtime prompt must pass context without replacing the loaded skill for ${phrase}.`);
}

for (const filePath of [
  'lib/agents/ba-agent.ts',
  'lib/agents/tech-stack-agent.ts',
  'lib/agents/dev-agent.ts',
  'lib/agents/qa-agent.ts',
  'lib/validation/generated-project.ts',
  'lib/validation/repair-scope.ts',
  'app/page.tsx',
  'app/api/runs/route.ts',
  'lib/orchestrator.ts'
]) {
  assertNotMatches(filePath, new RegExp(`${'Simple Shopping ' + 'Cart'}|${'Watch shopping ' + 'cart'}`, 'i'), 'Demo-domain defaults must not be hard-coded in runtime source.');
  assertNotMatches(
    filePath,
    new RegExp([`${'Postgre'}SQL`, `${'Fast'}API`, `${'Next'}\\.js`, `${'SQL'}ite`, `${'NEXT'}_PUBLIC_API_BASE_URL`].join('|'), 'i'),
    'Technology defaults and skill behavior belong in skill.md, not runtime source.'
  );
}

assertIncludes(
  'lib/validation/generated-project.ts',
  'readFirstGenerationContract',
  'Static readiness validation must read the first-generation contract from the DEV skill.'
);

console.log('First DEV skill validation passed.');
