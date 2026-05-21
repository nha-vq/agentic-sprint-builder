import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import type { GeneratedFile, RequirementImage, RunResult } from '@/lib/types';

export async function runBAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[] | null;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  signal?: AbortSignal;
}) {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const imageContext = input.requirementImages?.length
    ? `\nATTACHED IMAGES: ${input.requirementImages.length} requirement image(s) attached. Analyze them as UI mockups/wireframes/screenshots. Produce a concrete "Frontend Visual Design Contract" section with page-to-image mapping, visual scope boundaries, layout/composition, typography, color/surface tokens, components/states, media treatment, responsive behavior, and DEV implementation notes. Separate visual fidelity from functional scope so out-of-scope mockup features can be static/disabled instead of implemented as full workflows.`
    : '';

  return runMarkdownSkillAgent({
    agentId: 'ba',
    signal: input.signal,
    images: input.requirementImages ?? undefined,
    userPrompt: `
Use the loaded BA skill to analyze the provided context and produce the structured BA output required by that skill.
Application source only provides context below; BA behavior, assumptions, and output requirements come from the loaded skill.

REQUIREMENTS:
${input.requirements}

TECH SPEC:
${techSpec}
${imageContext}

EXISTING GENERATED CODE:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });
}
