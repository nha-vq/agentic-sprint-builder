import fs from 'fs/promises';
import path from 'path';
import type { FreeImageCandidate, PreparedMediaAsset } from '@/lib/types';

const DEFAULT_MEDIA_LIMIT = 4;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 2_500_000;
const ASSET_DIR = 'frontend/public/assets/generated-media';
const MANIFEST_PATH = `${ASSET_DIR}/media-manifest.json`;

export type PreparedMediaAssetFile = PreparedMediaAsset & {
  content: Buffer;
};

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mediaLimit() {
  return readPositiveIntegerEnv('MEDIA_ASSET_LIMIT', DEFAULT_MEDIA_LIMIT);
}

function downloadTimeoutMs() {
  return readPositiveIntegerEnv('MEDIA_ASSET_DOWNLOAD_TIMEOUT_MS', DEFAULT_DOWNLOAD_TIMEOUT_MS);
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'media'
  );
}

function mimeToExtension(mimeType: string) {
  if (/png/i.test(mimeType)) return { mimeType: 'image/png' as const, extension: 'png' };
  if (/webp/i.test(mimeType)) return { mimeType: 'image/webp' as const, extension: 'webp' };
  return { mimeType: 'image/jpeg' as const, extension: 'jpg' };
}

function isSupportedContentType(contentType: string) {
  return /^image\/(?:jpeg|jpg|png|webp)(?:;|$)/i.test(contentType);
}

async function downloadCandidate(candidate: FreeImageCandidate, index: number, signal?: AbortSignal): Promise<PreparedMediaAssetFile | null> {
  const downloadUrl = candidate.thumbUrl || candidate.imageUrl;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), downloadTimeoutMs());
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(downloadUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*',
        'User-Agent': 'agentic-sprint-builder/1.0'
      },
      signal: controller.signal
    });

    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!isSupportedContentType(contentType)) return null;

    const content = Buffer.from(await response.arrayBuffer());
    if (content.length === 0 || content.length > MAX_IMAGE_BYTES) return null;

    const mime = mimeToExtension(contentType);
    const baseName = `${String(index + 1).padStart(2, '0')}-${slugify(candidate.title)}`;
    const assetPath = `${ASSET_DIR}/${baseName}.${mime.extension}`;

    return {
      title: candidate.title,
      path: assetPath,
      publicUrl: `/assets/generated-media/${baseName}.${mime.extension}`,
      sourceImageUrl: candidate.imageUrl,
      sourcePageUrl: candidate.pageUrl,
      downloadUrl,
      license: candidate.license,
      licenseUrl: candidate.licenseUrl,
      query: candidate.query,
      mimeType: mime.mimeType,
      sizeBytes: content.length,
      content
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }
}

function metadata(asset: PreparedMediaAssetFile): PreparedMediaAsset {
  return {
    title: asset.title,
    path: asset.path,
    publicUrl: asset.publicUrl,
    sourceImageUrl: asset.sourceImageUrl,
    sourcePageUrl: asset.sourcePageUrl,
    downloadUrl: asset.downloadUrl,
    license: asset.license,
    licenseUrl: asset.licenseUrl,
    query: asset.query,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes
  };
}

export async function prepareMediaAssets(candidates: FreeImageCandidate[], signal?: AbortSignal) {
  const files: PreparedMediaAssetFile[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (files.length >= mediaLimit()) break;
    const key = (candidate.thumbUrl || candidate.imageUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const asset = await downloadCandidate(candidate, files.length, signal);
    if (asset) files.push(asset);
  }

  return {
    assets: files.map(metadata),
    files
  };
}

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function resolveAssetPath(relativePath: string) {
  const base = getGeneratedCodeDir();
  const destination = path.resolve(base, relativePath);
  const relative = path.relative(base, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Prepared media asset path escapes generated-code: ${relativePath}`);
  }
  return destination;
}

export async function writePreparedMediaAssets(files: PreparedMediaAssetFile[]) {
  if (files.length === 0) return [];

  for (const file of files) {
    const destination = resolveAssetPath(file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content);
  }

  const assets = files.map(metadata);
  const manifestPath = resolveAssetPath(MANIFEST_PATH);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        assets
      },
      null,
      2
    ),
    'utf-8'
  );

  return assets;
}

export function formatPreparedMediaAssetsForPrompt(assets?: PreparedMediaAsset[] | null) {
  if (!assets?.length) {
    return 'No local prepared media assets were downloaded. Do not use generic placeholder image services; use CSS treatment or relevant licensed URLs from BA/UX only.';
  }

  return `Prepared local media assets are available and will be written into the generated app. Use these public URLs in frontend code and seed data instead of remote placeholder services.
${assets
  .map(
    (asset, index) => `${index + 1}. ${asset.title}
  Public URL: ${asset.publicUrl}
  File path: ${asset.path}
  Source image: ${asset.sourceImageUrl}
  Source page: ${asset.sourcePageUrl}
  License: ${asset.license}${asset.licenseUrl ? `\n  License URL: ${asset.licenseUrl}` : ''}
  Query: ${asset.query}`
  )
  .join('\n')}`;
}
