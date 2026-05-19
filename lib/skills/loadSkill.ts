import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { AgentId } from '@/lib/types';

const SkillMetaSchema = z.object({
  agent_id: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  temperature: z.coerce.number().optional()
});

export interface LoadedSkill {
  raw: string;
  meta: z.infer<typeof SkillMetaSchema>;
  body: string;
  sourcePath?: string;
}

export function parseSkillMarkdown(markdown: string, sourcePath?: string): LoadedSkill {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { raw: markdown, meta: {}, body: markdown, sourcePath };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (!key || rest.length === 0) continue;
    meta[key.trim()] = rest.join(':').trim().replace(/^['"]|['"]$/g, '');
  }

  return {
    raw: markdown,
    meta: SkillMetaSchema.parse(meta),
    body: match[2],
    sourcePath
  };
}

async function firstExistingPath(paths: string[]) {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Try the next convention.
    }
  }

  return null;
}

export async function loadSkill(agentId: AgentId): Promise<LoadedSkill> {
  const filePath = await firstExistingPath([
    path.join(process.cwd(), '.github', 'skills', agentId, 'SKILL.md'),
    path.join(process.cwd(), '.github', 'skills', `${agentId}.md`)
  ]);

  if (!filePath) {
    throw new Error(`Missing skill for ${agentId}. Expected .github/skills/${agentId}/SKILL.md or .github/skills/${agentId}.md.`);
  }

  const markdown = await fs.readFile(filePath, 'utf-8');
  return parseSkillMarkdown(markdown, filePath);
}
