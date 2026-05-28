import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedProjectOverview, formatRunHistoryContext } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import type { FreeImageCandidate, GeneratedFile, PreparedTechStackOutput, RequirementImage, RunResult, UXContractOutput } from '@/lib/types';

const UXContractOutputSchema = z.object({
  summary: z.string().min(1).max(4_000),
  informationArchitecture: z.string().min(1).max(8_000),
  layoutContract: z.string().min(1).max(10_000),
  componentInventory: z.array(z.string().min(1).max(1_000)).min(1).max(60),
  visualDesignTokens: z.string().min(1).max(10_000),
  imageTreatment: z.string().min(1).max(8_000),
  responsiveRules: z.string().min(1).max(8_000),
  interactionRules: z.string().min(1).max(8_000),
  consistencyRules: z.array(z.string().min(1).max(1_000)).min(1).max(50),
  devHandoffChecklist: z.array(z.string().min(1).max(1_000)).min(1).max(50)
});

const UXContractJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'informationArchitecture',
    'layoutContract',
    'componentInventory',
    'visualDesignTokens',
    'imageTreatment',
    'responsiveRules',
    'interactionRules',
    'consistencyRules',
    'devHandoffChecklist'
  ],
  properties: {
    summary: { type: 'string' },
    informationArchitecture: { type: 'string' },
    layoutContract: { type: 'string' },
    componentInventory: { type: 'array', items: { type: 'string' } },
    visualDesignTokens: { type: 'string' },
    imageTreatment: { type: 'string' },
    responsiveRules: { type: 'string' },
    interactionRules: { type: 'string' },
    consistencyRules: { type: 'array', items: { type: 'string' } },
    devHandoffChecklist: { type: 'array', items: { type: 'string' } }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldAllowDegradedUx() {
  return process.env.UX_AGENT_ALLOW_DEGRADED !== 'false';
}

function getUxFallbackModel() {
  return process.env.UX_AGENT_FALLBACK_MODEL?.trim() || 'anthropic/claude-sonnet-4.6';
}

function formatRequirementImageContext(images?: RequirementImage[] | null) {
  if (!images?.length) return 'No requirement images are attached.';
  return [
    `${images.length} requirement image(s) are attached. Inspect them directly as the visual source of truth.`,
    ...images.map((image, index) => `- Image ${index + 1}: ${image.name} (${image.mimeType}, ${Math.round(image.sizeBytes / 1024)} KB)`)
  ].join('\n');
}

function formatFreeImageCandidateContext(candidates?: FreeImageCandidate[] | null) {
  if (!candidates?.length) return 'No free/safe image candidates were provided.';
  return candidates
    .map((candidate, index) => {
      const thumb = candidate.thumbUrl ? `\n  Thumb: ${candidate.thumbUrl}` : '';
      return `${index + 1}. ${candidate.title}
  Query: ${candidate.query}
  Image URL: ${candidate.imageUrl}
  Source page: ${candidate.pageUrl}
  License: ${candidate.license}${thumb}`;
    })
    .join('\n');
}

export function formatUXContractForPrompt(contract?: UXContractOutput | null) {
  if (!contract) return 'No UX contract is available.';
  return [
    `Summary: ${contract.summary}`,
    '',
    `Information Architecture:\n${contract.informationArchitecture}`,
    '',
    `Layout Contract:\n${contract.layoutContract}`,
    '',
    `Component Inventory:\n${contract.componentInventory.map((item) => `- ${item}`).join('\n')}`,
    '',
    `Visual Design Tokens:\n${contract.visualDesignTokens}`,
    '',
    `Image Treatment:\n${contract.imageTreatment}`,
    '',
    `Responsive Rules:\n${contract.responsiveRules}`,
    '',
    `Interaction Rules:\n${contract.interactionRules}`,
    '',
    `Consistency Rules:\n${contract.consistencyRules.map((item) => `- ${item}`).join('\n')}`,
    '',
    `DEV Handoff Checklist:\n${contract.devHandoffChecklist.map((item) => `- ${item}`).join('\n')}`
  ].join('\n');
}

export function createDegradedUXContract(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedTechStack: PreparedTechStackOutput;
  baOutput: string;
  reason: string;
}): UXContractOutput {
  const imageNames = input.requirementImages?.length ? input.requirementImages.map((image) => image.name).join(', ') : 'no attached mockups';
  const hasMockups = (input.requirementImages?.length ?? 0) > 0;
  const imageCandidateNote = input.freeImageCandidates?.length
    ? `Use only relevant free/safe candidates from BA media planning; reject candidates that do not match the mockup subject, crop, and tone.`
    : `Treat missing licensed media as a visual asset blocker for product cards, hero media, galleries, and detail pages. Preserve image-slot aspect ratios, but do not present empty placeholders as completed product imagery.`;

  return {
    summary: `Degraded UX contract generated because UX model call failed: ${input.reason}. DEV must use BA visual contract, requirements, and attached mockups (${imageNames}) as the source of truth.`,
    informationArchitecture: [
      'Preserve the routes, pages, navigation, header, footer, and user flows described by BA and requirements.',
      hasMockups ? 'Map each attached mockup to the corresponding route before implementing frontend files.' : 'No mockup image was available; use BA output as the visual source of truth.',
      `Frontend stack: ${input.preparedTechStack.frontendFramework}. Backend stack: ${input.preparedTechStack.backendFramework}.`
    ].join('\n'),
    layoutContract: [
      'Implement the exact in-scope page hierarchy and section order described by BA output.',
      'When mockups are attached, match visible structure: header, navigation, hero/media area, product/list cards, detail layout, static buttons, newsletter/forms if shown, and footer density.',
      'Do not replace the mockup with a generic adjacent layout. Static/non-functional UI may be rendered when it is visible in mockups but outside functional scope.',
      `BA visual guidance excerpt:\n${truncate(input.baOutput, 4_000)}`
    ].join('\n\n'),
    componentInventory: [
      'AppShell/Header/Footer: preserve visible mockup chrome and brand identity.',
      'Home/List Page: render required data with mockup-matched list/card structure and imagery.',
      'Detail Page: render a working seeded/example detail route with mockup-matched image/details/specification layout.',
      'Product/Card Components: keep prop contracts consistent between call sites and component definitions.',
      'API Client: separate browser public URL from Docker internal server URL when server rendering is used.'
    ],
    visualDesignTokens: [
      'Extract colors, typography scale, spacing, borders, radius, shadows, and icon treatment from attached mockups or BA visual contract.',
      'Preserve visible brand/product names and major headings unless requirements explicitly override them.',
      'Avoid generic one-size-fits-all ecommerce styling when mockups provide concrete visual direction.'
    ].join('\n'),
    imageTreatment: [
      hasMockups ? `Attached mockups: ${imageNames}. Use them as visual reference for crop, aspect ratio, contrast, and media placement.` : 'No attached mockups; use BA output for image treatment.',
      imageCandidateNote,
      'Generated app must not show broken images. Prefer local assets under frontend/public/assets when remote image reliability is uncertain.',
      'If using Next.js next/image with remote images, include every remote hostname in next.config and ensure Docker runtime includes that config.'
    ].join('\n'),
    responsiveRules: [
      'Use mobile-first responsive rules.',
      'Keep mockup structure on desktop; stack columns and preserve image/card aspect ratios on smaller screens.',
      'Text and controls must not overlap, overflow, or disappear.'
    ].join('\n'),
    interactionRules: [
      'Required navigation and detail routes must work with seeded data.',
      'Visible but out-of-scope controls may be static/disabled, but they must not break layout.',
      'Show useful loading/error states only when unavoidable; final smoke validation must render data, not permanent error fallbacks.'
    ].join('\n'),
    consistencyRules: [
      'Do not rename the visible brand/product identity from mockups unless explicit requirements do so.',
      'Do not remove visible mockup sections just because their backend behavior is out of scope.',
      'Do not pass validation with HTTP 200 if required data, images, or detail routes are broken.',
      'Keep frontend/backend API contracts and component prop contracts aligned.',
      'Preserve this degraded UX contract until a successful UX agent contract replaces it.'
    ],
    devHandoffChecklist: [
      'Inspect attached mockups before planning frontend files.',
      'Map each mockup to a route and component list in README Visual Fidelity Notes.',
      'Use browser-reachable public API URLs for client code and internal Compose URLs for server-side frontend code.',
      'Verify home/list page, one detail page, and rendered images after Docker startup.',
      'For App Router, mark client components with use client only when hooks/browser APIs/event handlers are used.'
    ]
  };
}

export async function runUXAgent(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedTechStack: PreparedTechStackOutput;
  baOutput: string;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  modelOverride?: string;
  signal?: AbortSignal;
}): Promise<UXContractOutput> {
  const projectOverview = formatGeneratedProjectOverview(input.existingFiles ?? []);
  const runHistory = formatRunHistoryContext(input.recentRuns ?? []);

  const prompt = `
Create a stable UX/UI contract for DEV. Return JSON only.

REQUIREMENTS:
${truncate(input.requirements, 5_000)}

TECH SPEC:
${truncate(input.techSpec?.trim() || 'Not provided', 4_000)}

REQUIREMENT IMAGE CONTEXT:
${formatRequirementImageContext(input.requirementImages)}

FREE/SAFE IMAGE CANDIDATES:
${formatFreeImageCandidateContext(input.freeImageCandidates)}

BA OUTPUT:
${truncate(input.baOutput, 8_000)}

PREPARED TECH STACK:
${JSON.stringify(input.preparedTechStack, null, 2)}

EXISTING GENERATED PROJECT OVERVIEW:
${projectOverview}

RECENT RUN HISTORY:
${runHistory}

Rules:
- Make the UI direction deterministic and reusable across reruns.
- Translate mockups into concrete layout, component, token, image, responsive, and interaction rules.
- Include "do not improvise" rules that prevent DEV from changing visual direction during repairs.
- Do not add product flows or backend features not requested by requirements/BA.
- If the frontend stack is App Router, include client/server component boundaries in the handoff checklist.
`;

  async function runWithModel(modelOverride: string | undefined, maxRetries: number) {
    const raw = await runMarkdownSkillAgent({
      agentId: 'ux',
      modelOverride,
      fallbackTemperature: 0.15,
      maxTokens: 16_384,
      signal: input.signal,
      images: input.requirementImages?.length ? input.requirementImages : undefined,
      jsonSchema: {
        name: 'ux_contract_output',
        schema: UXContractJsonSchema
      },
      retry: { maxRetries },
      userPrompt: prompt
    });

    return UXContractOutputSchema.parse(extractJsonObject(raw));
  }

  const maxRetries = readPositiveIntEnv('UX_AGENT_MAX_RETRIES', readPositiveIntEnv('LLM_MAX_RETRIES', 2));
  let lastError: unknown;

  try {
    return await runWithModel(input.modelOverride, maxRetries);
  } catch (error) {
    lastError = error;
    if (input.signal?.aborted) throw error;
  }

  const fallbackModel = getUxFallbackModel();
  if (fallbackModel && fallbackModel !== input.modelOverride) {
    try {
      return await runWithModel(fallbackModel, readPositiveIntEnv('AGENT_FALLBACK_MAX_RETRIES', 1));
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) throw error;
    }
  }

  if (!shouldAllowDegradedUx()) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return createDegradedUXContract({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: input.requirementImages,
    freeImageCandidates: input.freeImageCandidates,
    preparedTechStack: input.preparedTechStack,
    baOutput: input.baOutput,
    reason: lastError instanceof Error ? lastError.message : String(lastError)
  });
}
