interface OpenRouterInput {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
}

export async function callOpenRouter(input: OpenRouterInput): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY. Add it to .env.local.');
  }

  const model = input.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Agentic Sprint Builder'
    },
    body: JSON.stringify({
      model,
      temperature: input.temperature ?? 0.2,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter response did not include content');
  return content;
}
