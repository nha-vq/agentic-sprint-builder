export async function callLLM({
  system,
  user,
  model = "gpt-4.1-mini",
  temperature,
  jsonSchema
}: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const requestBody: Record<string, unknown> = {
    model,
    input: [
      {
        role: "system",
        content: system,
      },
      {
        role: "user",
        content: user,
      },
    ],
  };

  if (temperature !== undefined) {
    requestBody.temperature = temperature;
  }

  if (jsonSchema) {
    requestBody.text = {
      format: {
        type: 'json_schema',
        name: jsonSchema.name,
        strict: true,
        schema: jsonSchema.schema
      }
    };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[openai] API request failed with status ${res.status}: ${errorText}`);
    throw new Error(`OpenAI API request failed with status ${res.status}.`);
  }

  const data = await res.json();

  if (typeof data.output_text === 'string') return data.output_text;

  const outputText = data.output
    ?.flatMap((item: { content?: Array<{ text?: string; type?: string }> }) => item.content ?? [])
    ?.map((content: { text?: string }) => content.text)
    ?.filter(Boolean)
    ?.join('\n');

  return outputText ?? "";
}
