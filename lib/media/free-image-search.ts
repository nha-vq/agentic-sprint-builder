import type { FreeImageCandidate } from '@/lib/types';

const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const SEARCH_TIMEOUT_MS = 7_500;
const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 6;

const STOP_WORDS = new Set([
  'about',
  'above',
  'after',
  'again',
  'agent',
  'agents',
  'also',
  'and',
  'app',
  'application',
  'are',
  'artifact',
  'based',
  'build',
  'can',
  'create',
  'dashboard',
  'data',
  'default',
  'delete',
  'description',
  'developer',
  'does',
  'each',
  'every',
  'feature',
  'files',
  'flow',
  'from',
  'generate',
  'have',
  'image',
  'images',
  'implementation',
  'input',
  'into',
  'need',
  'needs',
  'only',
  'page',
  'phase',
  'product',
  'project',
  'requirement',
  'requirements',
  'safe',
  'search',
  'should',
  'show',
  'stack',
  'story',
  'tech',
  'test',
  'that',
  'the',
  'their',
  'then',
  'this',
  'through',
  'user',
  'using',
  'when',
  'will',
  'with',
  'write'
]);

const BLOCKED_TERMS = [
  'adult',
  'blood',
  'corpse',
  'explicit',
  'gore',
  'graphic',
  'naked',
  'nude',
  'nudity',
  'porn',
  'sex',
  'sexual',
  'violence',
  'weapon'
];

type CommonsImageInfo = {
  url?: string;
  thumburl?: string;
  mime?: string;
  extmetadata?: Record<string, { value?: string }>;
};

type CommonsPage = {
  title?: string;
  imageinfo?: CommonsImageInfo[];
};

type CommonsResponse = {
  query?: {
    pages?: Record<string, CommonsPage>;
  };
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function metadataValue(info: CommonsImageInfo, key: string) {
  return decodeHtmlEntities(info.extmetadata?.[key]?.value || '');
}

function isAllowedLicense(license: string) {
  if (!license) return false;
  if (/non.?free|fair use|copyrighted|all rights reserved/i.test(license)) return false;
  return /public domain|cc0|cc by|cc-by|cc by-sa|cc-by-sa|creative commons/i.test(license);
}

function isSafeText(value: string) {
  const normalized = value.toLowerCase();
  return !BLOCKED_TERMS.some((term) => normalized.includes(term));
}

function isSupportedImage(info: CommonsImageInfo) {
  const url = info.url || '';
  const mime = info.mime || '';
  if (!url.startsWith('https://')) return false;
  if (mime && (!mime.startsWith('image/') || mime === 'image/svg+xml' || mime === 'image/gif')) return false;
  return !/\.(svg|gif|tif|tiff)(\?|$)/i.test(url);
}

function normalizeKeyword(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function extractKeywords(text: string) {
  const counts = new Map<string, number>();
  const matcher = /[A-Za-z][A-Za-z0-9-]{2,}/g;

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const keyword = normalizeKeyword(match[0]);
    if (!keyword || STOP_WORDS.has(keyword) || keyword.length < 3 || keyword.length > 28) continue;
    counts.set(keyword, (counts.get(keyword) || 0) + 1);
  }

  const entries: Array<[string, number]> = [];
  counts.forEach((count, keyword) => {
    entries.push([keyword, count]);
  });

  return entries
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, 10);
}

function extractTitleQuery(text: string) {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim())
    .find((item) => item.length >= 8 && !/^[-+*]\s/.test(item));

  if (!line) return '';

  const words = line
    .match(/[A-Za-z][A-Za-z0-9-]{2,}/g)
    ?.map(normalizeKeyword)
    .filter((word) => word && !STOP_WORDS.has(word))
    .slice(0, 5);

  return words?.join(' ') || '';
}

function buildQueries(params: { requirements: string; techSpec?: string | null; topic?: string }) {
  const text = `${params.topic || ''}\n${params.requirements}\n${params.techSpec || ''}`;
  const keywords = extractKeywords(text);
  const titleQuery = extractTitleQuery(params.requirements);
  const baseQuery = titleQuery || keywords.slice(0, 4).join(' ') || params.topic || 'modern application';
  const secondaryQuery = keywords.slice(0, 5).join(' ');

  return [baseQuery, secondaryQuery, `${baseQuery} mockup interface`]
    .map((query) => query.trim().replace(/\s+/g, ' '))
    .filter((query, index, queries) => query.length > 0 && queries.indexOf(query) === index)
    .slice(0, MAX_QUERIES);
}

async function fetchCommonsCandidates(query: string, signal?: AbortSignal): Promise<FreeImageCandidate[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: String(MAX_RESULTS_PER_QUERY),
    gsrsearch: query,
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: '900',
    origin: '*',
    prop: 'imageinfo'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(`${COMMONS_API_URL}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'agentic-sprint-builder/1.0'
      },
      signal: controller.signal
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as CommonsResponse;
    const pages = Object.values(payload.query?.pages ?? {});

    return pages.flatMap((page) => {
      const info = page.imageinfo?.[0];
      const title = decodeHtmlEntities((page.title || '').replace(/^File:/i, ''));
      if (!info || !title || !isSupportedImage(info) || !isSafeText(`${title} ${info.url}`)) return [];

      const license = metadataValue(info, 'LicenseShortName') || metadataValue(info, 'UsageTerms');
      if (!isAllowedLicense(license)) return [];

      const pageUrl = metadataValue(info, 'DescriptionUrl') || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || title).replace(/%20/g, '_')}`;
      const licenseUrl = metadataValue(info, 'LicenseUrl') || undefined;

      return [
        {
          title,
          pageUrl,
          imageUrl: info.url!,
          thumbUrl: info.thumburl,
          license,
          licenseUrl,
          source: 'Wikimedia Commons' as const,
          query
        }
      ];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function searchFreeSafeImages(params: {
  requirements: string;
  techSpec?: string | null;
  topic?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FreeImageCandidate[]> {
  const queries = buildQueries(params);
  const results = await Promise.all(queries.map((query) => fetchCommonsCandidates(query, params.signal)));
  const seen = new Set<string>();
  const candidates: FreeImageCandidate[] = [];

  for (const candidate of results.flat()) {
    const key = candidate.imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= (params.limit ?? 8)) break;
  }

  return candidates;
}
