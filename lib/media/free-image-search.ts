import type { FreeImageCandidate } from '@/lib/types';

const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const OPENVERSE_IMAGES_API_URL = 'https://api.openverse.org/v1/images/';
const SEARCH_TIMEOUT_MS = 7_500;
const MAX_QUERIES = 8;
const MAX_RESULTS_PER_QUERY = 10;

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
  'cart',
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
  'implementing',
  'input',
  'into',
  'layout',
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
  'shopping',
  'simple',
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

const GENERIC_QUERY_TERMS = new Set([
  'collection',
  'ecommerce',
  'interface',
  'luxury',
  'modern',
  'photo',
  'product',
  'safe',
  'store'
]);

const WATCH_CONTEXT_TERMS = ['chronograph', 'clock', 'horology', 'mechanical', 'timepiece', 'timepieces', 'watch', 'watches', 'wristwatch', 'wristwatches'];

const WATCH_REJECT_TERMS = [
  'apartment',
  'apartments',
  'building',
  'buildings',
  'flat',
  'flats',
  'geograph',
  'hotel',
  'house',
  'road',
  'street'
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

type OpenverseImage = {
  title?: string;
  foreign_landing_url?: string;
  url?: string;
  thumbnail?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  source?: string;
  provider?: string;
  mature?: boolean;
  filetype?: string | null;
  category?: string | null;
  tags?: Array<{ name?: string }>;
};

type OpenverseResponse = {
  results?: OpenverseImage[];
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
  const normalized = license.toLowerCase();
  if (/non.?free|fair use|copyrighted|all rights reserved|noncommercial|\bnc\b|no derivatives|\bnd\b/i.test(normalized)) return false;
  return /public domain|publicdomain|pdm|cc0|cc by|cc-by|cc by-sa|cc-by-sa|creative commons|\bby\b|\bby-sa\b/i.test(normalized);
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

function isSupportedImageUrl(url: string, mimeOrExtension?: string | null) {
  if (!url.startsWith('https://')) return false;
  if (mimeOrExtension && /svg|gif|tiff?|bmp/i.test(mimeOrExtension)) return false;
  return !/\.(svg|gif|tif|tiff|bmp)(\?|$)/i.test(url);
}

function candidateSearchText(candidate: Pick<FreeImageCandidate, 'title' | 'imageUrl' | 'pageUrl'>) {
  return `${candidate.title} ${candidate.imageUrl} ${candidate.pageUrl}`.toLowerCase().replace(/[_-]+/g, ' ');
}

function significantQueryTerms(query: string) {
  return (
    query
      .match(/[A-Za-z][A-Za-z0-9-]{2,}/g)
      ?.map(normalizeKeyword)
      .filter((term) => term && !STOP_WORDS.has(term) && !GENERIC_QUERY_TERMS.has(term)) ?? []
  );
}

function isRelevantCandidate(query: string, candidate: Pick<FreeImageCandidate, 'title' | 'imageUrl' | 'pageUrl'>) {
  const queryTerms = significantQueryTerms(query);
  if (queryTerms.length === 0) return true;

  const text = candidateSearchText(candidate);
  const watchQuery = queryTerms.some((term) => WATCH_CONTEXT_TERMS.includes(term));
  if (watchQuery) {
    return WATCH_CONTEXT_TERMS.some((term) => text.includes(term)) && !WATCH_REJECT_TERMS.some((term) => text.includes(term));
  }

  return queryTerms.some((term) => text.includes(term));
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

function cleanSubjectPhrase(value: string) {
  const words =
    value
      .match(/[A-Za-z][A-Za-z0-9-]{1,}/g)
      ?.map(normalizeKeyword)
      .filter((word) => word && !STOP_WORDS.has(word) && !/^(full|stack|frontend|backend|ui|ux|nfrs?|mockups?|screenshots?)$/.test(word))
      .slice(0, 4) ?? [];

  return words.join(' ');
}

function extractDomainQueries(text: string) {
  const normalized = text.toLowerCase();

  if (/\b(?:watch|watches|wristwatch|wristwatches|timepiece|timepieces)\b/i.test(text)) {
    return [
      'wristwatch',
      'chronograph watch',
      'mechanical watch movement',
      'luxury wristwatch product photo',
      'watch dial macro',
      'watch movement macro'
    ];
  }

  const subjectPatterns = [
    /\bbuild\s+(?:a|an|the)?\s*(?:full-stack\s+)?(.{3,80}?)(?:\s+(?:shopping cart|e-?commerce|store|shop|catalog|product|app|application)\b)/i,
    /\b(?:store|shop|catalog|marketplace)\s+(?:for|of)\s+(.{3,80}?)(?:[.\n]|$)/i,
    /\b(?:products?|items?)\s+(?:for|of)\s+(.{3,80}?)(?:[.\n]|$)/i
  ];

  for (const pattern of subjectPatterns) {
    const subject = cleanSubjectPhrase(pattern.exec(text)?.[1] || '');
    if (subject) {
      return [`${subject} product photo`, `${subject} product collection`, `${subject} ecommerce product`];
    }
  }

  const domainKeywords = extractKeywords(normalized).filter(
    (word) => !/^(home|detail|header|footer|navigation|navbar|menu|mockup|wireframe|screen|screens|pages?)$/.test(word)
  );
  const subject = domainKeywords.slice(0, 2).join(' ');
  return subject ? [`${subject} product photo`, `${subject} product collection`] : [];
}

function buildQueries(params: { requirements: string; techSpec?: string | null; topic?: string }) {
  const text = `${params.topic || ''}\n${params.requirements}\n${params.techSpec || ''}`;
  const domainQueries = extractDomainQueries(text);
  const keywords = extractKeywords(text);
  const titleQuery = extractTitleQuery(params.requirements);
  const baseQuery = titleQuery || keywords.slice(0, 4).join(' ') || params.topic || 'modern application';
  const secondaryQuery = keywords.slice(0, 5).join(' ');

  return [...domainQueries, baseQuery, secondaryQuery, `${baseQuery} product photo`, `${baseQuery} product collection`, `${baseQuery} product interface`]
    .map((query) => query.trim().replace(/\s+/g, ' '))
    .filter((query, index, queries) => query.length > 0 && queries.indexOf(query) === index)
    .slice(0, MAX_QUERIES);
}

function formatOpenverseLicense(item: OpenverseImage) {
  const license = item.license?.trim();
  if (!license) return '';
  const version = item.license_version?.trim();
  if (/^(cc0|pdm|by|by-sa)$/i.test(license)) {
    return version ? `CC ${license.toUpperCase()} ${version}` : `CC ${license.toUpperCase()}`;
  }
  return version ? `${license} ${version}` : license;
}

function openverseSearchText(item: OpenverseImage) {
  return [
    item.title,
    item.url,
    item.foreign_landing_url,
    item.source,
    item.provider,
    item.category,
    ...(item.tags?.map((tag) => tag.name) ?? [])
  ]
    .filter(Boolean)
    .join(' ');
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

      const candidate = {
        title,
        pageUrl,
        imageUrl: info.url!,
        thumbUrl: info.thumburl,
        license,
        licenseUrl,
        source: 'Wikimedia Commons' as const,
        query
      };

      return isRelevantCandidate(query, candidate) ? [candidate] : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function fetchOpenverseCandidates(query: string, signal?: AbortSignal): Promise<FreeImageCandidate[]> {
  const params = new URLSearchParams({
    q: query,
    page_size: String(MAX_RESULTS_PER_QUERY),
    mature: 'false'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(`${OPENVERSE_IMAGES_API_URL}?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agentic-sprint-builder/1.0'
      },
      signal: controller.signal
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as OpenverseResponse;
    return (payload.results ?? []).flatMap((item) => {
      const title = decodeHtmlEntities(item.title || '');
      const imageUrl = item.url || '';
      const pageUrl = item.foreign_landing_url || '';
      const license = formatOpenverseLicense(item);
      const safetyText = openverseSearchText(item);

      if (
        item.mature ||
        !title ||
        !imageUrl ||
        !pageUrl ||
        !isSafeText(safetyText) ||
        !isSupportedImageUrl(imageUrl, item.filetype) ||
        !isAllowedLicense(license)
      ) {
        return [];
      }

      const candidate = {
        title,
        pageUrl,
        imageUrl,
        thumbUrl: item.thumbnail,
        license,
        licenseUrl: item.license_url || undefined,
        source: 'Openverse' as const,
        query
      };

      return isRelevantCandidate(query, candidate) ? [candidate] : [];
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
  const results = await Promise.all(
    queries.flatMap((query) => [fetchOpenverseCandidates(query, params.signal), fetchCommonsCandidates(query, params.signal)])
  );
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
