function parseJsonFragment(fragment: string): unknown {
  try {
    return JSON.parse(fragment);
  } catch (error) {
    if (error instanceof SyntaxError && /unexpected end|unterminated/i.test(error.message)) {
      throw new Error(`Model response contained incomplete JSON. The response was likely truncated. ${error.message}`);
    }

    throw error;
  }
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('}')) {
    throw new Error('Model response started a JSON object but did not finish it. The response was likely truncated.');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return parseJsonFragment(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return parseJsonFragment(fenced[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end < start) {
    throw new Error('Model response started a JSON object but did not finish it. The response was likely truncated.');
  }

  if (start >= 0 && end > start) return parseJsonFragment(trimmed.slice(start, end + 1));

  throw new Error('No JSON object found in model response');
}
