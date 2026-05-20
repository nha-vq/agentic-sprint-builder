interface OpenRouterInput {
  system: string;
  user: string;
  images?: Array<{ dataUrl: string }>;
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
}

interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
}

const DEFAULT_MODEL = 'google/gemini-2.5-pro';
const DEFAULT_MAX_TOKENS = 65_536;

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function callOpenRouter(input: OpenRouterInput): Promise<string> {
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

  throw new Error('OpenRouter response did not include content');
}
