import { loadSkill } from '@/lib/skills/loadSkill';
import { callOpenRouter } from '@/lib/openrouter';
import type { AgentId } from '@/lib/types';

export async function runMarkdownSkillAgent(params: {
  agentId: AgentId;
  userPrompt: string;
  fallbackModel?: string;
  fallbackTemperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  systemAppend?: string;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}) {
  const skill = await loadSkill(params.agentId);
  const system = params.systemAppend?.trim() ? `${skill.body}\n\n${params.systemAppend.trim()}` : skill.body;

  return callOpenRouter({
    system,
    user: params.userPrompt,
    model: skill.meta.model || params.fallbackModel,
    temperature: skill.meta.temperature ?? params.fallbackTemperature ?? 0.2,
    maxTokens: params.maxTokens,
    signal: params.signal,
    jsonSchema: params.jsonSchema
  });
}
