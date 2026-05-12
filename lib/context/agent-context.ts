import type { GeneratedFile, RunResult } from '@/lib/types';

const MAX_CODE_FILES = 30;
const MAX_CODE_FILE_CHARS = 6_000;
const MAX_CODE_CONTEXT_CHARS = 70_000;
const MAX_HISTORY_RUNS = 5;
const MAX_HISTORY_SECTION_CHARS = 1_500;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function formatGeneratedCodeContext(files: GeneratedFile[]) {
  if (files.length === 0) return 'No existing generated code.';

  const sections: string[] = [];
  let totalChars = 0;

  for (const file of files.slice(0, MAX_CODE_FILES)) {
    const content = truncate(file.content, MAX_CODE_FILE_CHARS);
    const section = `### ${file.path}\n\n\`\`\`\n${content}\n\`\`\``;

    if (totalChars + section.length > MAX_CODE_CONTEXT_CHARS) {
      sections.push('...[generated code context truncated]');
      break;
    }

    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

export function formatRunHistoryContext(runs: RunResult[]) {
  if (runs.length === 0) return 'No previous runs.';

  return runs
    .slice(0, MAX_HISTORY_RUNS)
    .map((run) => {
      const files = run.devOutput?.files?.map((file) => file.path).join(', ') || 'No generated files recorded.';
      const findings = run.qaFindings?.length ? run.qaFindings.join('; ') : 'No QA findings recorded.';

      return [
        `## ${run.runId}`,
        `Created: ${run.createdAt}`,
        `Topic: ${run.topic}`,
        `QA status: ${run.qaStatus || 'Not recorded'}`,
        `Build readiness fix iterations: ${run.buildReadinessFixIterations ?? 0}`,
        `QA fix iterations: ${run.qaFixIterations ?? 0}`,
        `Generated files: ${files}`,
        `QA findings: ${truncate(findings, MAX_HISTORY_SECTION_CHARS)}`,
        `BA excerpt:\n${truncate(run.baOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `QA report excerpt:\n${truncate(run.qaOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Setup excerpt:\n${truncate(run.devOutput?.setupInstructions || '', MAX_HISTORY_SECTION_CHARS)}`
      ].join('\n');
    })
    .join('\n\n');
}
