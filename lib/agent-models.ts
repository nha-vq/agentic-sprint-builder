import type { AgentId, AgentModelMap } from '@/lib/types';

export const AGENT_MODEL_IDS = [
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.7',
  'google/gemini-2.5-pro',
  'anthropic/claude-haiku-4.5'
] as const;

export const AGENT_MODEL_OPTIONS: Array<{ value: (typeof AGENT_MODEL_IDS)[number]; label: string }> = [
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' }
];

export const DEFAULT_AGENT_MODELS: Record<AgentId, (typeof AGENT_MODEL_IDS)[number]> = {
  ba: 'google/gemini-2.5-flash',
  'tech-stack': 'anthropic/claude-sonnet-4.6',
  ux: 'google/gemini-2.5-pro',
  dev: 'anthropic/claude-sonnet-4.6',
  'frontend-dev': 'anthropic/claude-sonnet-4.6',
  'backend-dev': 'anthropic/claude-sonnet-4.6',
  'integration-dev': 'anthropic/claude-sonnet-4.6',
  'code-review': 'anthropic/claude-sonnet-4.6',
  deploy: 'google/gemini-2.5-flash',
  qa: 'google/gemini-2.5-flash'
};

export function agentModelFor(agentId: AgentId, models?: AgentModelMap | null) {
  return models?.[agentId] || DEFAULT_AGENT_MODELS[agentId];
}
