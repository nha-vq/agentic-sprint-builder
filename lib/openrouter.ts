interface OpenRouterInput {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
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
    content: string;
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

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = 32_768;

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function callOpenRouter(input: OpenRouterInput): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY. Add it to .env.local.');
  }

  const model = input.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? readPositiveIntEnv('OPENROUTER_MAX_TOKENS', DEFAULT_MAX_TOKENS);
  const requestBody: OpenRouterRequestBody = {
    model,
    temperature: input.temperature ?? 0.2,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user }
    ]
  };

  if (input.jsonSchema) {
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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Agentic Sprint Builder'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
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
