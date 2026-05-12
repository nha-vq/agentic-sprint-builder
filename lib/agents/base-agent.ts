import { loadSkill } from '@/lib/skills/loadSkill';
// import { callOpenRouter } from '@/lib/openrouter';
import { callLLM } from "@/lib/openai";
import type { AgentId } from '@/lib/types';

export async function runMarkdownSkillAgent(params: {
  agentId: AgentId;
  userPrompt: string;
  fallbackModel?: string;
  fallbackTemperature?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}) {
  const skill = await loadSkill(params.agentId);

  // Local test path: use OpenAI directly. DEV agent can pass jsonSchema here
  // to force structured JSON output from the OpenAI Responses API.
  return await callLLM({
    system: skill.body,
    user: params.userPrompt,
    model: process.env.OPENAI_MODEL,
    temperature: skill.meta.temperature ?? params.fallbackTemperature,
    jsonSchema: params.jsonSchema
  });

  // Future OpenRouter path: uncomment the import above and this block when
  // switching back to OpenRouter. If DEV still needs strict JSON, add the
  // equivalent response_format/json_schema support in lib/openrouter.ts.
  // return callOpenRouter({
  //   system: skill.body,
  //   user: params.userPrompt,
  //   model: skill.meta.model || params.fallbackModel,
  //   temperature: skill.meta.temperature ?? params.fallbackTemperature ?? 0.2
  // });
}
