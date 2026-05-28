import type {
  DevOutput,
  FreeImageCandidate,
  GeneratedExecutionValidationResult,
  PreparedMediaAsset,
  PreparedTechStackOutput,
  ProjectSpecArtifact,
  QAReviewOutput,
  RequirementImage,
  RunCostSummary,
  UXContractOutput
} from '@/lib/types';

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function section(title: string, content: string) {
  return [`## ${title}`, '', content.trim() || 'Not provided.'].join('\n');
}

function bulletList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None recorded.';
}

function jsonBlock(value: unknown, maxChars = 8_000) {
  return ['```json', truncate(JSON.stringify(value, null, 2), maxChars), '```'].join('\n');
}

function imageSummary(images?: RequirementImage[] | null) {
  if (!images?.length) return '- No requirement mockup images were provided.';
  return images.map((image) => `- ${image.name} (${image.mimeType}, ${Math.round(image.sizeBytes / 1024)} KB)`).join('\n');
}

function freeImageSummary(candidates?: FreeImageCandidate[] | null) {
  if (!candidates?.length) return '- No free/safe image candidates were prepared.';
  return candidates
    .slice(0, 8)
    .map((candidate) => `- ${candidate.title} (${candidate.license}) from ${candidate.source}: ${candidate.imageUrl}`)
    .join('\n');
}

function mediaAssetSummary(assets?: PreparedMediaAsset[] | null) {
  if (!assets?.length) return '- No local media assets were prepared.';
  return assets.map((asset) => `- ${asset.title}: ${asset.publicUrl} (${asset.license})`).join('\n');
}

function formatTechStack(stack?: PreparedTechStackOutput) {
  if (!stack) return 'Not prepared.';
  return jsonBlock(stack, 10_000);
}

function formatUxContract(contract?: UXContractOutput | null) {
  if (!contract) return 'Not prepared.';
  return [
    `Summary: ${contract.summary}`,
    '',
    section('Information Architecture', contract.informationArchitecture),
    section('Layout Contract', contract.layoutContract),
    section('Component Inventory', bulletList(contract.componentInventory)),
    section('Visual Design Tokens', contract.visualDesignTokens),
    section('Image Treatment', contract.imageTreatment),
    section('Responsive Rules', contract.responsiveRules),
    section('Interaction Rules', contract.interactionRules),
    section('Consistency Rules', bulletList(contract.consistencyRules)),
    section('DEV Handoff Checklist', bulletList(contract.devHandoffChecklist))
  ].join('\n\n');
}

export function buildPreDevSpecArtifacts(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  preparedTechStack?: PreparedTechStackOutput;
  uxContract?: UXContractOutput | null;
  requirementImages?: RequirementImage[] | null;
  freeImageCandidates?: FreeImageCandidate[] | null;
  preparedMediaAssets?: PreparedMediaAsset[] | null;
}): ProjectSpecArtifact[] {
  const techSpec = input.techSpec?.trim() || 'Not provided.';

  return [
    {
      kind: 'requirements',
      title: 'Requirements Spec',
      path: 'specs/requirements.spec.md',
      content: [
        '# Requirements Spec',
        '',
        'This is the stable source-of-truth contract for DEV and QA. If later agent output conflicts with this spec, the explicit requirement and BA acceptance criteria win.',
        '',
        section('User Requirements', truncate(input.requirements, 12_000)),
        section('Tech Spec Input', truncate(techSpec, 8_000)),
        section('BA Artifacts', truncate(input.baOutput, 12_000)),
        section('Mockup Inputs', imageSummary(input.requirementImages)),
        section('Free/Safe Image Candidates', freeImageSummary(input.freeImageCandidates)),
        section('Prepared Local Media Assets', mediaAssetSummary(input.preparedMediaAssets))
      ].join('\n\n')
    },
    {
      kind: 'ux',
      title: 'UX Spec',
      path: 'specs/ux.spec.md',
      content: [
        '# UX Spec',
        '',
        'DEV must implement this visual and interaction contract consistently across runs. QA must compare generated UI behavior and layout against this contract and uploaded mockups.',
        '',
        section('Stable UX/UI Contract', formatUxContract(input.uxContract)),
        section(
          'Visual Acceptance Rules',
          bulletList([
            'Match uploaded mockup structure, spacing, typography, colors, and visible content before adding optional embellishment.',
            'Use prepared local media assets when they are relevant; do not replace mockup-driven UI with generic stock imagery.',
            'Keep responsive behavior deterministic for desktop and mobile validation.',
            'Do not hide core product content behind landing-page marketing sections unless requirements explicitly ask for it.'
          ])
        )
      ].join('\n\n')
    },
    {
      kind: 'architecture',
      title: 'Architecture Spec',
      path: 'specs/architecture.spec.md',
      content: [
        '# Architecture Spec',
        '',
        'This spec records TA stack decisions. DEV must use these choices for generated files, commands, ports, environment variables, and container behavior.',
        '',
        section('Prepared Tech Stack', formatTechStack(input.preparedTechStack))
      ].join('\n\n')
    }
  ];
}

export function buildFinalSpecArtifacts(input: {
  preDevSpecArtifacts: ProjectSpecArtifact[];
  devOutput: DevOutput;
  projectDevContextPath?: string;
  codeReviewStatus?: 'PASS' | 'NEEDS_FIX';
  codeReviewSummary?: string;
  deployValidationStatus?: 'PASS' | 'NEEDS_FIX';
  deployValidationSummary?: string;
  executionValidation?: GeneratedExecutionValidationResult;
  qaReview: QAReviewOutput;
  costSummary?: RunCostSummary;
  costControlNotes?: string[];
}): ProjectSpecArtifact[] {
  return [
    ...input.preDevSpecArtifacts,
    {
      kind: 'implementation',
      title: 'Implementation Spec',
      path: 'specs/implementation.spec.md',
      content: [
        '# Implementation Spec',
        '',
        'This spec records the delivered file contract for this run.',
        '',
        section('TA DEV Context', input.projectDevContextPath || 'Not recorded.'),
        section('Architecture', truncate(input.devOutput.architecture, 10_000)),
        section(
          'Generated File Manifest',
          input.devOutput.files.map((file) => `- ${file.path} (${Buffer.byteLength(file.content, 'utf8')} bytes)`).join('\n')
        ),
        section('Setup Instructions', truncate(input.devOutput.setupInstructions, 8_000))
      ].join('\n\n')
    },
    {
      kind: 'validation',
      title: 'Validation Spec',
      path: 'specs/validation.spec.md',
      content: [
        '# Validation Spec',
        '',
        'This spec records the gates used to accept or repair the generated product.',
        '',
        section('Code Review Gate', [`Status: ${input.codeReviewStatus || 'Not recorded'}`, `Summary: ${input.codeReviewSummary || 'Not recorded.'}`].join('\n')),
        section('Deploy Gate', [`Status: ${input.deployValidationStatus || 'Not recorded'}`, `Summary: ${input.deployValidationSummary || 'Not recorded.'}`].join('\n')),
        section('Execution Gate', input.executionValidation ? jsonBlock(input.executionValidation, 12_000) : 'Not recorded.'),
        section(
          'QA Gate',
          [`Status: ${input.qaReview.status}`, 'Findings:', bulletList(input.qaReview.findings), '', 'Fix Instructions:', input.qaReview.fixInstructions || 'None.'].join('\n')
        ),
        section('Cost Summary', input.costSummary ? jsonBlock(input.costSummary, 6_000) : 'Not recorded.'),
        section('Cost Controls', bulletList(input.costControlNotes ?? []))
      ].join('\n\n')
    }
  ];
}

export function formatSpecArtifactsForPrompt(artifacts?: ProjectSpecArtifact[] | null, maxTotalChars = 12_000) {
  if (!artifacts?.length) return 'No spec artifacts prepared.';

  const chunks: string[] = [];
  let used = 0;

  for (const artifact of artifacts) {
    const header = `# ${artifact.title}\nPath: ${artifact.path}\nKind: ${artifact.kind}\n\n`;
    const remaining = maxTotalChars - used - header.length;
    if (remaining <= 0) break;

    const content = truncate(artifact.content, Math.max(800, remaining));
    chunks.push(`${header}${content}`);
    used += header.length + content.length;
  }

  return chunks.join('\n\n---\n\n');
}
