import fs from 'fs/promises';
import path from 'path';
import type { RequirementImage, RunResult, VisualComparisonImage, VisualComparisonResult } from '@/lib/types';

const REPORTS_DIR = 'reports';
const REPORT_ASSETS_DIR = 'assets';

function reportsDir() {
  return path.resolve(process.cwd(), REPORTS_DIR);
}

function reportsAssetsDir() {
  return path.join(reportsDir(), REPORT_ASSETS_DIR);
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'asset';
}

function escapeHtml(value: string | number | undefined | null) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mimeExtension(mimeType: string) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function readPngDimensions(buffer: Buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readWebpDimensions(buffer: Buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return null;
}

function readImageDimensions(buffer: Buffer, mimeType?: string) {
  let dimensions: { width: number; height: number } | null = null;
  try {
    dimensions =
      mimeType === 'image/webp'
        ? readWebpDimensions(buffer)
        : mimeType === 'image/jpeg'
          ? readJpegDimensions(buffer)
          : readPngDimensions(buffer) || readJpegDimensions(buffer) || readWebpDimensions(buffer);
  } catch {
    dimensions = null;
  }

  if (!dimensions?.width || !dimensions.height) return {};
  return {
    ...dimensions,
    aspectRatio: Number((dimensions.width / dimensions.height).toFixed(4))
  };
}

function reportAssetPath(fileName: string) {
  return `${REPORT_ASSETS_DIR}/${fileName}`.replace(/\\/g, '/');
}

async function writeRequirementMockups(runId: string, images?: RequirementImage[] | null): Promise<VisualComparisonImage[]> {
  if (!images?.length) return [];

  await fs.mkdir(reportsAssetsDir(), { recursive: true });
  const mockups: VisualComparisonImage[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const parsed = parseDataUrl(image.dataUrl);
    if (!parsed) continue;

    const fileName = `${runId}-mockup-${index + 1}-${safeName(image.name)}.${mimeExtension(parsed.mimeType)}`;
    const outputPath = path.join(reportsAssetsDir(), fileName);
    await fs.writeFile(outputPath, parsed.buffer);
    mockups.push({
      label: `Mockup ${index + 1}`,
      name: image.name,
      assetPath: reportAssetPath(fileName),
      sourcePath: image.name,
      ...readImageDimensions(parsed.buffer, parsed.mimeType)
    });
  }

  return mockups;
}

function extractScreenshotPaths(result: RunResult) {
  const screenshots: Array<{ label: string; sourcePath: string }> = [];
  const seen = new Set<string>();

  for (const step of result.executionValidation?.steps ?? []) {
    const matches = Array.from(step.message.matchAll(/Screenshot:\s*([^\r\n]+?\.png)/gi));
    for (const match of matches) {
      const sourcePath = match[1].trim();
      if (seen.has(sourcePath)) continue;
      seen.add(sourcePath);
      screenshots.push({ label: step.name, sourcePath });
    }
  }

  return screenshots;
}

async function copyValidationScreenshots(result: RunResult): Promise<VisualComparisonImage[]> {
  const screenshotPaths = extractScreenshotPaths(result);
  if (!screenshotPaths.length) return [];

  await fs.mkdir(reportsAssetsDir(), { recursive: true });
  const screenshots: VisualComparisonImage[] = [];

  for (let index = 0; index < screenshotPaths.length; index += 1) {
    const screenshot = screenshotPaths[index];
    try {
      const buffer = await fs.readFile(screenshot.sourcePath);
      const fileName = `${result.runId}-screenshot-${index + 1}-${safeName(screenshot.label)}.png`;
      const outputPath = path.join(reportsAssetsDir(), fileName);
      await fs.writeFile(outputPath, buffer);
      screenshots.push({
        label: screenshot.label,
        name: path.basename(screenshot.sourcePath),
        assetPath: reportAssetPath(fileName),
        sourcePath: screenshot.sourcePath,
        ...readImageDimensions(buffer, 'image/png')
      });
    } catch {
      // Screenshots are best-effort evidence; missing files are reported by findings.
    }
  }

  return screenshots;
}

function bestAspectDiff(screenshot: VisualComparisonImage, mockups: VisualComparisonImage[]) {
  if (!screenshot.aspectRatio || mockups.length === 0) return null;
  const diffs = mockups
    .map((mockup) => (mockup.aspectRatio ? Math.abs(screenshot.aspectRatio! - mockup.aspectRatio) : null))
    .filter((value): value is number => value !== null);
  return diffs.length ? Math.min(...diffs) : null;
}

function validationEvidenceText(result: RunResult) {
  return [
    result.qaOutput,
    ...(result.executionValidation?.findings ?? []),
    ...(result.executionValidation?.steps ?? []).map((step) => `${step.name}: ${step.message}`)
  ].join('\n');
}

function scoreVisualComparison(params: {
  result: RunResult;
  mockups: VisualComparisonImage[];
  screenshots: VisualComparisonImage[];
}) {
  const findings: string[] = [];
  const recommendations: string[] = [];
  const evidence = validationEvidenceText(params.result);
  let score = 0;

  if (params.mockups.length === 0) {
    findings.push('No requirement mockup images were attached to this run, so screenshot comparison is limited.');
    recommendations.push('Attach mockup images before the next run to enable visual comparison.');
  } else {
    score += 15;
  }

  if (params.screenshots.length === 0) {
    findings.push('No browser screenshots were captured by execution validation.');
    recommendations.push('Enable browser validation and configure Chrome/Edge if screenshots are missing.');
  } else {
    score += 15;
  }

  const aspectDiffs = params.screenshots
    .map((screenshot) => bestAspectDiff(screenshot, params.mockups))
    .filter((value): value is number => value !== null);
  if (aspectDiffs.length > 0) {
    const averageDiff = aspectDiffs.reduce((sum, value) => sum + value, 0) / aspectDiffs.length;
    score += Math.round(Math.max(0, 20 - Math.min(20, averageDiff * 30)));
    if (averageDiff > 0.35) {
      findings.push(`Generated screenshot aspect ratio differs from mockups by ${averageDiff.toFixed(2)} on average.`);
      recommendations.push('Ask UX/DEV to match the mockup viewport composition, section density, and responsive frame.');
    }
  }

  if (params.result.executionValidation?.status === 'PASS') {
    score += 25;
  } else if (params.result.executionValidation?.status === 'SKIPPED') {
    score += 8;
    findings.push('Execution validation was skipped, so visual pass confidence is limited.');
  } else {
    findings.push('Execution validation did not pass.');
  }

  if (/unable to load|failed to fetch|cors|net::err|browser dom did not show|runtime javascript error/i.test(evidence)) {
    findings.push('Browser evidence contains runtime/data loading failure text.');
    recommendations.push('Fix browser-visible data loading before judging final visual fidelity.');
  } else {
    score += 15;
  }

  if (/generic placeholder|picsum\.photos|placehold\.co|dummyimage|loremflickr|browser DOM does not use prepared local media assets/i.test(evidence)) {
    findings.push('Image evidence indicates placeholder imagery or ignored prepared media assets.');
    recommendations.push('Use prepared local `/assets/generated-media/...` images for mockup/product imagery.');
  } else if ((params.result.preparedMediaAssets?.length ?? 0) > 0) {
    score += 10;
  }

  if (params.result.costBudgetExceeded) {
    findings.push('Run reached or exceeded the configured cost budget.');
  }

  score = Math.max(0, Math.min(100, score));
  const status =
    params.mockups.length === 0 || params.screenshots.length === 0
      ? 'SKIPPED'
      : score >= 75 && params.result.executionValidation?.status === 'PASS'
        ? 'PASS'
        : score >= 50
          ? 'NEEDS_REVIEW'
          : 'NEEDS_FIX';

  if (recommendations.length === 0) {
    recommendations.push('Review the side-by-side screenshot/mockup evidence before accepting visual fidelity.');
  }

  return {
    status,
    score,
    findings: Array.from(new Set(findings)),
    recommendations: Array.from(new Set(recommendations))
  } satisfies Pick<VisualComparisonResult, 'status' | 'score' | 'findings' | 'recommendations'>;
}

function formatUsd(value: number | undefined) {
  if (typeof value !== 'number') return '$0.0000';
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function renderImageCards(title: string, images: VisualComparisonImage[]) {
  if (!images.length) return `<p class="muted">No ${escapeHtml(title.toLowerCase())} captured.</p>`;

  return `<div class="image-grid">${images
    .map(
      (image) => `<figure>
        <img src="${escapeHtml(image.assetPath)}" alt="${escapeHtml(image.label)}" />
        <figcaption>
          <b>${escapeHtml(image.label)}</b>
          <span>${escapeHtml(image.name)}</span>
          <span>${image.width && image.height ? `${image.width} x ${image.height}` : 'dimensions unknown'}</span>
        </figcaption>
      </figure>`
    )
    .join('')}</div>`;
}

function renderList(items: string[]) {
  if (!items.length) return '<li>None recorded.</li>';
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderReport(result: RunResult, comparison: VisualComparisonResult) {
  const dashboardAccepted = result.events.filter((event) => event.dashboardAccepted).length;
  const dashboardRejected = result.events.filter((event) => !event.dashboardAccepted && event.dashboardError).length;
  const validationFindings = result.executionValidation?.findings ?? [];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Team Observation - ${escapeHtml(result.runId)}</title>
  <style>
    :root { color-scheme: light; --ink:#172033; --muted:#667085; --line:#d9e0ea; --ok:#077d55; --warn:#ad5b00; --bad:#b42318; --blue:#155eef; --bg:#f6f8fb; }
    body { margin:0; font-family: Inter, Segoe UI, Arial, sans-serif; background:var(--bg); color:var(--ink); line-height:1.5; }
    main { max-width:1180px; margin:0 auto; padding:32px 20px 56px; }
    h1 { margin:0 0 8px; font-size:30px; }
    h2 { margin:28px 0 10px; font-size:20px; }
    .card { background:white; border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; box-shadow:0 1px 2px rgba(16,24,40,.04); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
    .metric { border:1px solid var(--line); border-radius:10px; padding:12px; background:#fbfcfe; }
    .metric b { display:block; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
    .metric span { display:block; margin-top:4px; font-size:18px; font-weight:700; }
    .pill { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; font-weight:700; background:#eef2f6; }
    .PASS { color:var(--ok); background:#e7f8f0; }
    .NEEDS_REVIEW, .SKIPPED { color:var(--warn); background:#fff3e1; }
    .NEEDS_FIX { color:var(--bad); background:#fde8e7; }
    .image-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
    figure { margin:0; border:1px solid var(--line); border-radius:10px; background:#fbfcfe; overflow:hidden; }
    img { display:block; width:100%; max-height:520px; object-fit:contain; background:#101828; }
    figcaption { display:grid; gap:2px; padding:10px; font-size:12px; color:var(--muted); }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:8px 10px; }
    th { color:#344054; background:#f8fafc; }
    code { background:#eef2f6; padding:1px 4px; border-radius:4px; }
    .muted { color:var(--muted); }
  </style>
</head>
<body>
<main>
  <h1>AI Team Observation</h1>
  <p class="muted">Run id: <code>${escapeHtml(result.runId)}</code> · ${escapeHtml(new Date(result.createdAt).toLocaleString())}</p>

  <section class="card grid">
    <div class="metric"><b>Visual Status</b><span><span class="pill ${comparison.status}">${comparison.status}</span></span></div>
    <div class="metric"><b>Visual Score</b><span>${comparison.score}/100</span></div>
    <div class="metric"><b>Execution</b><span>${escapeHtml(result.executionValidation?.status || 'not recorded')}</span></div>
    <div class="metric"><b>QA</b><span>${escapeHtml(result.qaStatus || 'not recorded')}</span></div>
    <div class="metric"><b>Cost</b><span>${escapeHtml(formatUsd(result.costSummary?.totalUsd))}</span></div>
    <div class="metric"><b>Calls</b><span>${escapeHtml(result.costSummary?.totalCalls ?? 0)}</span></div>
  </section>

  <section class="card">
    <h2>Findings</h2>
    <ul>${renderList(comparison.findings)}</ul>
  </section>

  <section class="card">
    <h2>Recommendations</h2>
    <ul>${renderList(comparison.recommendations)}</ul>
  </section>

  <section class="card">
    <h2>Mockups</h2>
    ${renderImageCards('Mockups', comparison.mockups)}
  </section>

  <section class="card">
    <h2>Generated Screenshots</h2>
    ${renderImageCards('Generated Screenshots', comparison.screenshots)}
  </section>

  <section class="card">
    <h2>Run Metrics</h2>
    <table>
      <tbody>
        <tr><td>Code review fix iterations</td><td>${escapeHtml(result.codeReviewFixIterations ?? 0)}</td></tr>
        <tr><td>DevOps fix iterations</td><td>${escapeHtml(result.deployFixIterations ?? 0)}</td></tr>
        <tr><td>Static readiness fix iterations</td><td>${escapeHtml(result.buildReadinessFixIterations ?? 0)}</td></tr>
        <tr><td>Execution validation fix iterations</td><td>${escapeHtml(result.executionValidationFixIterations ?? 0)}</td></tr>
        <tr><td>QA fix iterations</td><td>${escapeHtml(result.qaFixIterations ?? 0)}</td></tr>
        <tr><td>Total tokens</td><td>${escapeHtml(result.costSummary?.totalTokens ?? 0)}</td></tr>
        <tr><td>Prepared media assets</td><td>${escapeHtml(result.preparedMediaAssets?.length ?? 0)}</td></tr>
        <tr><td>Dashboard events</td><td>${escapeHtml(`${result.events.length} emitted, ${dashboardAccepted} accepted, ${dashboardRejected} rejected`)}</td></tr>
      </tbody>
    </table>
  </section>

  <section class="card">
    <h2>Execution Validation Findings</h2>
    <ul>${renderList(validationFindings)}</ul>
  </section>

  <section class="card">
    <h2>Cost Controls</h2>
    <ul>${renderList(result.costControlNotes ?? [])}</ul>
  </section>
</main>
</body>
</html>`;
}

export async function generateObservationReport(result: RunResult, options: { requirementImages?: RequirementImage[] | null }) {
  await fs.mkdir(reportsDir(), { recursive: true });
  await fs.mkdir(reportsAssetsDir(), { recursive: true });

  const mockups = await writeRequirementMockups(result.runId, options.requirementImages);
  const screenshots = await copyValidationScreenshots(result);
  const scored = scoreVisualComparison({ result, mockups, screenshots });
  const reportFileName = `${result.runId}-agent-observation.html`;
  const reportPath = path.join(reportsDir(), reportFileName);
  const reportUrl = `/api/reports/${reportFileName}`;
  const comparison: VisualComparisonResult = {
    ...scored,
    reportPath,
    reportUrl,
    mockups,
    screenshots
  };

  await fs.writeFile(reportPath, renderReport(result, comparison), 'utf-8');
  return comparison;
}
