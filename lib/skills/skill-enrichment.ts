import fs from 'fs/promises';
import path from 'path';
import type { PreparedTechStackOutput } from '@/lib/types';

export interface EnrichedSkillContext {
  baseTemplates: string;
  techEnrichment: string;
  combined: string;
}

async function loadBaseTemplate(templateId: string): Promise<string> {
  const candidates = [
    path.join(process.cwd(), '.github', 'skills', templateId, 'SKILL.md'),
    path.join(process.cwd(), '.github', 'skills', `${templateId}.md`)
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const content = await fs.readFile(candidate, 'utf-8');
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      return bodyMatch ? bodyMatch[1].trim() : content.trim();
    } catch {
      continue;
    }
  }

  return '';
}

function buildTechEnrichment(preparedTechStack: PreparedTechStackOutput): string {
  const sections: string[] = [];

  sections.push('## Tech Stack Enrichment Context');
  sections.push(`Frontend: ${preparedTechStack.frontendFramework}`);
  sections.push(`Backend: ${preparedTechStack.backendFramework}`);
  sections.push(`Database: ${preparedTechStack.database}`);
  sections.push(`ORM/Migration: ${preparedTechStack.ormMigrationTool}`);
  sections.push(`Package Manager: ${preparedTechStack.packageManager}`);
  sections.push(`Docker Strategy: ${preparedTechStack.dockerStrategy}`);
  sections.push(`Architecture: ${preparedTechStack.projectArchitecture}`);
  if (preparedTechStack.devSkillGuidance) {
    sections.push(`DEV Skill Guidance: ${preparedTechStack.devSkillGuidance}`);
  }

  if (preparedTechStack.runtimeVersions?.length) {
    sections.push('\n### Runtime Versions');
    for (const rt of preparedTechStack.runtimeVersions) {
      sections.push(`- ${rt.name}: ${rt.version}${rt.notes ? ` (${rt.notes})` : ''}`);
    }
  }

  if (preparedTechStack.servicePorts?.length) {
    sections.push('\n### Service Ports');
    for (const port of preparedTechStack.servicePorts) {
      sections.push(`- ${port.service}: host ${port.hostPort} → container ${port.containerPort} (${port.protocol})`);
    }
  }

  if (preparedTechStack.environmentVariables?.length) {
    sections.push('\n### Environment Variables');
    for (const env of preparedTechStack.environmentVariables) {
      sections.push(`- ${env.name} (${env.service}): ${env.purpose} [example: ${env.example}]${env.required ? ' [required]' : ''}`);
    }
  }

  if (preparedTechStack.assumptions?.length) {
    sections.push('\n### Assumptions');
    for (const assumption of preparedTechStack.assumptions) {
      sections.push(`- ${assumption}`);
    }
  }

  if (preparedTechStack.tradeoffs?.length) {
    sections.push('\n### Tradeoffs');
    for (const tradeoff of preparedTechStack.tradeoffs) {
      sections.push(`- ${tradeoff}`);
    }
  }

  return sections.join('\n');
}

export async function enrichSkillContext(preparedTechStack: PreparedTechStackOutput): Promise<EnrichedSkillContext> {
  const templateIds = [
    'base-fullstack',
    'base-frontend',
    'base-backend',
    'base-database'
  ];

  const templates = await Promise.all(templateIds.map(loadBaseTemplate));
  const baseTemplates = templates.filter(Boolean).join('\n\n---\n\n');
  const techEnrichment = buildTechEnrichment(preparedTechStack);

  return {
    baseTemplates,
    techEnrichment,
    combined: `${baseTemplates}\n\n---\n\n${techEnrichment}`
  };
}

export async function enrichReviewSkillContext(preparedTechStack: PreparedTechStackOutput): Promise<string> {
  const reviewTemplate = await loadBaseTemplate('base-review');
  const deployTemplate = await loadBaseTemplate('base-deploy');
  const qaTemplate = await loadBaseTemplate('base-qa');
  const techEnrichment = buildTechEnrichment(preparedTechStack);

  return [reviewTemplate, deployTemplate, qaTemplate, techEnrichment].filter(Boolean).join('\n\n---\n\n');
}
