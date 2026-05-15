import { loadSkill } from '@/lib/skills/loadSkill';
import { callOpenRouter } from '@/lib/openrouter';
import type { AgentId } from '@/lib/types';

export async function runMarkdownSkillAgent(params: {
  agentId: AgentId;
  userPrompt: string;
  fallbackModel?: string;
  fallbackTemperature?: number;
  maxTokens?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}) {
  const skill = await loadSkill(params.agentId);

  return callOpenRouter({
    system: skill.body,
    user: params.userPrompt,
    model: skill.meta.model || params.fallbackModel,
    temperature: skill.meta.temperature ?? params.fallbackTemperature ?? 0.2,
    maxTokens: params.maxTokens,
    jsonSchema: params.jsonSchema
  });
}
