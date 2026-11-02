import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAI, ProviderError, testConnection } from '../src/lib/ai/adapters';
import type { AiRequest } from '../src/lib/contracts';

const openaiRequest: AiRequest = { provider: 'openai', model: 'gpt-6-luna', prompt: 'Summarize the supplied data.', input: 'untrusted source', maxOutputTokens: 1000 };
const openaiResponse = { model: 'gpt-6-luna', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'A useful summary.' }] }], usage: { input_tokens: 100, output_tokens: 30 } };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('provider adapters — mocked HTTP contract tests, no live API calls', () => {
  it('calls Responses API with separate instructions/data and records actual reported tokens', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(openaiResponse));
    vi.stubGlobal('fetch', fetcher);
    const result = await callAI(openaiRequest, 'test-key-placeholder');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    expect(body.store).toBe(false);
    expect(body.instructions).not.toContain('untrusted source');
    expect(body.input[1].content).toContain('untrusted_input_data');
    expect(body).not.toHaveProperty('temperature');
    expect(result).toMatchObject({ inputTokens: 100, outputTokens: 30, costMicros: 25, text: 'A useful summary.' });
  });
  it('calls Anthropic Messages with its provider-specific contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Reviewed.' }], usage: { input_tokens: 50, output_tokens: 20 } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await callAI({ ...openaiRequest, provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'test-key-placeholder');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['anthropic-version']).toBe('2026-10-21');
    const body = JSON.parse(options.body);
    expect(body.max_tokens).toBe(1000);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.system).not.toContain('untrusted source');
    expect(result).toMatchObject({ text: 'Reviewed.', inputTokens: 50, outputTokens: 20, costMicros: 300 });
  });
  it('supports schema-bound output and rejects malformed model JSON while preserving billing usage', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...openaiResponse, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"result":"done"}' }] }] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await callAI({ ...openaiRequest, structuredOutput: true }, 'test-key-placeholder');
    expect(result.structuredData).toEqual({ result: 'done' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).text.format.type).toBe('json_schema');
    fetcher.mockResolvedValueOnce(jsonResponse(openaiResponse));
    await expect(callAI({ ...openaiRequest, structuredOutput: true }, 'test-key-placeholder')).rejects.toMatchObject({ status: 422, retriable: false, usage: { costMicros: 25 } });
  });
  it('classifies explicit provider errors without leaking upstream details', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'SECRET provider details' } }, 401));
    vi.stubGlobal('fetch', fetcher);
    await expect(callAI(openaiRequest, 'test-key-placeholder')).rejects.toMatchObject({ status: 401, retriable: false });
    fetcher.mockResolvedValueOnce(jsonResponse({ error: { type: 'rate_limit_error' } }, 429));
    await expect(callAI(openaiRequest, 'test-key-placeholder')).rejects.toMatchObject({ status: 429, retriable: true });
    fetcher.mockResolvedValueOnce(jsonResponse({ error: { code: 'insufficient_quota' } }, 429));
    await expect(callAI(openaiRequest, 'test-key-placeholder')).rejects.toMatchObject({ status: 429, retriable: false });
    fetcher.mockResolvedValueOnce(jsonResponse({ error: { message: 'SECRET' } }, 400));
    try { await callAI(openaiRequest, 'test-key-placeholder'); } catch (error) { expect((error as Error).message).not.toContain('SECRET'); }
  });
  it('does not retry ambiguous connection failures or cancelled requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network address or key details')));
    await expect(callAI(openaiRequest, 'test-key-placeholder')).rejects.toMatchObject({ retriable: false, status: 502 });
    const controller = new AbortController(); controller.abort();
    await expect(callAI(openaiRequest, 'test-key-placeholder', controller.signal)).rejects.toMatchObject({ status: 499, retriable: false });
  });
  it('preserves usage when a provider stops at the output limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...openaiResponse, status: 'incomplete' })));
    await expect(callAI(openaiRequest, 'test-key-placeholder')).rejects.toMatchObject({ retriable: false, usage: { inputTokens: 100, outputTokens: 30, costMicros: 25 } });
  });
  it('tests credentials through a read-only model-list request', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: [] })); vi.stubGlobal('fetch', fetcher);
    await testConnection('openai', 'test-key-placeholder');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
  });
  it('rejects unsupported settings before making a network request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(callAI({ ...openaiRequest, temperature: 0.5 }, 'test-key-placeholder')).rejects.toBeInstanceOf(ProviderError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
