import { recordLlmUsage } from '@/lib/llm/usage-tracker';
import type { AgentId } from '@/lib/types';

interface OpenRouterInput {
  system: string;
  user: string;
  images?: Array<{ dataUrl: string }>;
  agentId?: AgentId;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

interface OpenRouterRequestBody {
  model: string;
  temperature: number;
  max_tokens: number;
  messages: Array<{
    role: 'system' | 'user';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
  provider?: {
    require_parameters: true;
  };
  usage?: {
    include: true;
  };
}

export interface OpenRouterRetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoffMultiplier?: number;
}

export class OpenRouterEmptyContentError extends Error {
  constructor(message = 'OpenRouter response did not include content') {
    super(message);
    this.name = 'OpenRouterEmptyContentError';
  }
}

interface OpenRouterResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

const DEFAULT_MODEL = 'google/gemini-2.5-pro';
const DEFAULT_MAX_TOKENS = 65_536;
const MODEL_PRICING_PER_TOKEN: Record<string, { prompt: number; completion: number }> = {
  'google/gemini-2.5-flash': { prompt: 0.0000003, completion: 0.0000025 },
  'google/gemini-2.5-pro': { prompt: 0.00000125, completion: 0.00001 },
  'anthropic/claude-haiku-4.5': { prompt: 0.000001, completion: 0.000005 },
  'anthropic/claude-sonnet-4.6': { prompt: 0.000003, completion: 0.000015 },
  'anthropic/claude-opus-4.7': { prompt: 0.000005, completion: 0.000025 }
};

function numericUsageValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloatEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Run canceled by user.'));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Run canceled by user.'));
      },
      { once: true }
    );
  });
}

function isRetryableOpenRouterError(error: unknown) {
  if (error instanceof OpenRouterEmptyContentError) return true;
  if (!(error instanceof Error)) return false;
  return /OpenRouter error (408|409|425|429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|timeout|network|temporar|rate limit/i.test(error.message);
}

export function getOpenRouterRetryOptions(overrides?: OpenRouterRetryOptions) {
  return {
    maxRetries: overrides?.maxRetries ?? readPositiveIntEnv('LLM_MAX_RETRIES', 2),
    retryDelayMs: overrides?.retryDelayMs ?? readPositiveIntEnv('LLM_RETRY_DELAY_MS', 1500),
    retryBackoffMultiplier: overrides?.retryBackoffMultiplier ?? readPositiveFloatEnv('LLM_RETRY_BACKOFF_MULTIPLIER', 2)
  };
}

async function callOpenRouterOnce(input: OpenRouterInput): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || /^(your_openrouter_api_key|placeholder|changeme)$/i.test(apiKey)) {
    throw new Error('Missing OPENROUTER_API_KEY. Add it to .env.local.');
  }

  const model = input.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? readPositiveIntEnv('OPENROUTER_MAX_TOKENS', DEFAULT_MAX_TOKENS);

  const userContent = input.images?.length
    ? [
        { type: 'text' as const, text: input.user },
        ...input.images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: image.dataUrl }
        }))
      ]
    : input.user;

  const requestBody: OpenRouterRequestBody = {
    model,
    temperature: input.temperature ?? 0.2,
    max_tokens: maxTokens,
    usage: { include: true },
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: userContent }
    ]
  };

  if (input.jsonSchema) {
    const isAnthropicModel = model.startsWith('anthropic/');
    if (!isAnthropicModel) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: input.jsonSchema.name,
          strict: true,
          schema: input.jsonSchema.schema
        }
      };
      requestBody.provider = {
        require_parameters: true
      };
    }
    // Anthropic models handle JSON via system prompt; no json_schema param needed
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Agentic Sprint Builder'
    },
    body: JSON.stringify(requestBody),
    signal: input.signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(`OpenRouter authentication failed (${response.status}). Check OPENROUTER_API_KEY in .env.local or .env. Provider response: ${errorText}`);
    }

    throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const usage = data.usage;
  if (input.agentId && usage) {
    const promptTokens = numericUsageValue(usage.prompt_tokens);
    const completionTokens = numericUsageValue(usage.completion_tokens);
    const totalTokens = numericUsageValue(usage.total_tokens) || promptTokens + completionTokens;
    const fallbackPricing = MODEL_PRICING_PER_TOKEN[model];
    const fallbackCost = fallbackPricing ? promptTokens * fallbackPricing.prompt + completionTokens * fallbackPricing.completion : 0;
    const responseCost = numericUsageValue(usage.cost);

    recordLlmUsage({
      agentId: input.agentId,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: responseCost || fallbackCost,
      createdAt: new Date().toISOString(),
      responseId: data.id
    });
  }

  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error(`OpenRouter response was truncated at ${maxTokens} max_tokens. Increase OPENROUTER_MAX_TOKENS or reduce generated output size.`);
  }

  const content = choice?.message?.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const text = content.map((part) => part.text).filter(Boolean).join('\n');
    if (text) return text;
  }

  throw new OpenRouterEmptyContentError();
}

export async function callOpenRouter(input: OpenRouterInput & { retry?: OpenRouterRetryOptions }): Promise<string> {
  const retry = getOpenRouterRetryOptions(input.retry);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
    try {
      return await callOpenRouterOnce(input);
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenRouterError(error) || attempt >= retry.maxRetries) break;

      const delay = Math.round(retry.retryDelayMs * Math.pow(retry.retryBackoffMultiplier, attempt));
      await sleep(delay, input.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
