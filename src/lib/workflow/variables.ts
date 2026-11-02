export const MAX_VALUE_BYTES = 256 * 1024;
const variablePattern = /\{\{\s*steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.output\s*\}\}/g;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function assertValueSize(value: unknown, maximum = MAX_VALUE_BYTES): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).length > maximum) {
    throw new Error(`Step data exceeds the ${maximum} byte limit or is not JSON serializable.`);
  }
}

/** Only whole step outputs are addressable. No property traversal or evaluation. */
export function variableReferences(template: string): string[] {
  assertValueSize(template);
  const references = [...template.matchAll(variablePattern)].map((match) => match[1]);
  const remainder = template.replace(variablePattern, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('Invalid variable. Use {{steps.node_id.output}}.');
  }
  if (references.some((name) => forbidden.has(name))) throw new Error('Unsafe variable reference.');
  return references;
}

export function renderVariables(template: string, outputs: Record<string, unknown>): string {
  variableReferences(template);
  let bytes = new TextEncoder().encode(template).length;
  const rendered = template.replace(variablePattern, (match, id: string) => {
    if (!Object.hasOwn(outputs, id) || outputs[id] === undefined) {
      throw new Error(`Output for step ${id} is not available.`);
    }
    const output = outputs[id];
    const replacement = typeof output === 'string' ? output : JSON.stringify(output);
    assertValueSize(replacement);
    bytes += new TextEncoder().encode(replacement).length - new TextEncoder().encode(match).length;
    if (bytes > MAX_VALUE_BYTES) throw new Error('Resolved input exceeds the step data limit.');
    return replacement;
  });
  assertValueSize(rendered);
  return rendered;
}
