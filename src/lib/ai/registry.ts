import { z } from 'zod';
import type { ModelDefinition, Provider, AiRequest } from '../contracts';
import definitions from './models.json';

const modelSchema = z.object({
  id: z.string().min(1).max(128), provider: z.enum(['openai', 'anthropic']), name: z.string().min(1),
  inputMicrosPerToken: z.number().positive(), outputMicrosPerToken: z.number().positive(),
  maxOutputTokens: z.number().int().min(64).max(16384), supportsTemperature: z.boolean(), supportsJson: z.boolean(),
});

// This public registry contains capabilities and conservative standard text rates only.
// Update models.json when enabling a provider model; no secret belongs in this file.
export const models: ModelDefinition[] = z.array(modelSchema).min(1).parse(definitions);

export function getModel(id: string, provider?: Provider): ModelDefinition {
  const model = models.find((entry) => entry.id === id && (!provider || entry.provider === provider));
  if (!model) throw new Error('This model is not enabled in the TaskLLM model registry.');
  return model;
}

export function calculateCost(model: ModelDefinition, inputTokens: number, outputTokens: number): number {
  if (![inputTokens, outputTokens].every((count) => Number.isSafeInteger(count) && count >= 0)) throw new Error('Invalid token usage.');
  const cost = Math.ceil(inputTokens * model.inputMicrosPerToken + outputTokens * model.outputMicrosPerToken);
  if (!Number.isSafeInteger(cost)) throw new Error('Cost exceeds the supported range.');
  return cost;
}

export function estimateMaxCost(request: AiRequest): number {
  const model = getModel(request.model, request.provider);
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 64 || request.maxOutputTokens > model.maxOutputTokens) throw new Error('Output token limit is outside the supported range.');
  const bytes = new TextEncoder().encode([request.prompt, request.systemInstruction ?? '', JSON.stringify(request.input ?? '')].join('\n')).length;
  // UTF-8 byte count is a deliberately loose upper bound on text tokenization.
  // Restrict input to stay below providers' long-context pricing thresholds.
  if (bytes > 128 * 1024) throw new Error('AI input exceeds 128 KiB. Reduce the input before retrying.');
  return calculateCost(model, bytes + 4096, request.maxOutputTokens);
}
