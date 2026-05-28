import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import type { FreeImageCandidate, GeneratedFile, RequirementImage, RunResult } from '@/lib/types';

function formatFreeImageCandidates(candidates?: FreeImageCandidate[]) {
  if (!candidates?.length) {
    return 'No free/safe remote image candidates were found for this requirement. If imagery is required by product cards, hero media, galleries, or detail pages, record this as a media acquisition blocker. Do not instruct DEV to ship empty CSS/image placeholders as a completed visual implementation.';
  }

  return candidates
    .map((candidate, index) => {
      const thumb = candidate.thumbUrl ? `\n  Thumb: ${candidate.thumbUrl}` : '';
      const licenseUrl = candidate.licenseUrl ? `\n  License URL: ${candidate.licenseUrl}` : '';
      return `${index + 1}. ${candidate.title}
  Query: ${candidate.query}
  Image URL: ${candidate.imageUrl}
  Source page: ${candidate.pageUrl}
  License: ${candidate.license}${licenseUrl}${thumb}`;
    })
    .join('\n');
}

export async function runBAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[];
  modelOverride?: string;
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
    modelOverride: input.modelOverride,
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

FREE/SAFE IMAGE CANDIDATES:
${formatFreeImageCandidates(input.freeImageCandidates)}

When image candidates are relevant, choose image URLs that are visually close to the provided UI mockups or expected product imagery. Include selected URLs in Frontend Visual Design Contract > Media And Product Imagery and DEV Implementation Notes with source/license notes. If none are relevant, say so as a media blocker and require the media acquisition/DEV handoff to provide local licensed assets before declaring visual fidelity complete.

EXISTING GENERATED CODE:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });
}
