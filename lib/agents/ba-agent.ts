import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import type { GeneratedFile, RunResult } from '@/lib/types';

export async function runBAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  signal?: AbortSignal;
}) {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);

  return runMarkdownSkillAgent({
    agentId: 'ba',
    signal: input.signal,
    userPrompt: `
Use the loaded BA skill to analyze the provided context and produce the structured BA output required by that skill.
Application source only provides context below; BA behavior, assumptions, and output requirements come from the loaded skill.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${techSpec}

EXISTING GENERATED CODE:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });
}
