import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import type { GeneratedFile, RunResult } from '@/lib/types';

export async function runBAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
}) {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);

  return runMarkdownSkillAgent({
    agentId: 'ba',
    userPrompt: `
Analyze these Phase 1 inputs and produce BA artifacts.

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
