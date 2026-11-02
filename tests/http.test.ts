import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/server/db',()=>({query:mocks.query}));
import { checkOrigin,failure,HttpError,ok,rateLimit,readBody } from '../src/server/http';

beforeEach(()=>{vi.stubEnv('APP_URL','https://taskllm.example');mocks.query.mockReset();});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('Request boundary security',()=>{
  it('requires the exact application origin for mutations, including missing and null origins',()=>{
    for(const origin of [undefined,'null','https://attacker.example','https://taskllm.example.attacker.test','http://taskllm.example']) {
      const request=new Request('https://taskllm.example/api/profile',{method:'PATCH',headers:origin?{origin}:{}});
      expect(()=>checkOrigin(request)).toThrow('Request origin is not allowed.');
    }
    expect(()=>checkOrigin(new Request('https://taskllm.example/api/profile',{method:'PATCH',headers:{origin:'https://taskllm.example'}}))).not.toThrow();
    expect(()=>checkOrigin(new Request('https://taskllm.example/api/profile'))).not.toThrow();
  });
  it('validates JSON content types and malformed bodies',async()=>{
    await expect(readBody(new Request('https://taskllm.example',{method:'POST',body:'{}'}))).rejects.toMatchObject({status:415});
    await expect(readBody(new Request('https://taskllm.example',{method:'POST',headers:{'content-type':'application/json'},body:'{broken'}))).rejects.toMatchObject({status:400});
    await expect(readBody(new Request('https://taskllm.example',{method:'POST',headers:{'content-type':'application/json'}}))).rejects.toMatchObject({status:400});
    expect(await readBody(new Request('https://taskllm.example',{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:'{"name":"TaskLLM"}'}))).toEqual({name:'TaskLLM'});
  });
  it('measures actual UTF-8 body size instead of trusting Content-Length',async()=>{
    const body=JSON.stringify({text:'ą'.repeat(100)});
    const request=new Request('https://taskllm.example',{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body});
    await expect(readBody(request,150)).rejects.toMatchObject({status:413});
  });
  it('does not disclose arbitrary database or provider exceptions',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const response=failure(new Error('postgres://username:secret@database — sk-sensitive-value'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret|sk-sensitive|postgres/);
    const validation=z.object({name:z.string().min(1)}).safeParse({name:''});
    if(!validation.success)expect(failure(validation.error).status).toBe(400);
    expect(failure(new HttpError(403,'Denied.')).status).toBe(403);
  });
  it('marks authenticated responses as private and non-cacheable',async()=>{
    const response=ok({account:'private'});
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({data:{account:'private'}});
  });
  it('enforces the persisted rate counter and does not allow a failed counter lookup',async()=>{
    mocks.query.mockResolvedValueOnce([{hits:2}]).mockResolvedValueOnce([{hits:3}]);
    await expect(rateLimit('account:123',2,60)).resolves.toBeUndefined();
    await expect(rateLimit('account:123',2,60)).rejects.toMatchObject({status:429});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'),['account:123',60]);
    mocks.query.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(rateLimit('account:123',2,60)).rejects.toThrow();
  });
});
