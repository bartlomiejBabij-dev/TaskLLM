import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  auth:{signOut:vi.fn(),getUser:vi.fn(),updateUser:vi.fn(),resetPasswordForEmail:vi.fn(),signUp:vi.fn(),signInWithPassword:vi.fn()},query:vi.fn(),
}));
vi.mock('../src/server/auth',()=>({authClient:async()=>({auth:mocks.auth})}));
vi.mock('../src/server/db',()=>({query:mocks.query}));
import { POST } from '../src/app/api/auth/route';
const request=(body:unknown,origin='https://taskllm.example')=>new Request('https://taskllm.example/api/auth',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});

beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubEnv('APP_URL','https://taskllm.example');vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://test-project.supabase.co');vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','sb_publishable_test');vi.stubEnv('DATABASE_URL','postgresql://unused');
  mocks.query.mockResolvedValue([{hits:1}]);
  mocks.auth.signOut.mockResolvedValue({error:null});mocks.auth.getUser.mockResolvedValue({data:{user:null},error:null});mocks.auth.updateUser.mockResolvedValue({error:null});mocks.auth.resetPasswordForEmail.mockResolvedValue({error:null});mocks.auth.signUp.mockResolvedValue({data:{session:null},error:null});mocks.auth.signInWithPassword.mockResolvedValue({error:null});
});
afterEach(()=>vi.unstubAllEnvs());

describe('Supabase auth routes with explicit provider mocks',()=>{
  it('rejects CSRF and unavailable deployment configuration before contacting Supabase',async()=>{
    expect((await POST(request({action:'logout'},'https://attacker.test'))).status).toBe(403);
    vi.stubEnv('DATABASE_URL','');
    expect((await POST(request({action:'login',email:'test@example.test',password:'any'}))).status).toBe(503);
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it('enforces signup password policy but allows existing accounts to log in with older passwords',async()=>{
    expect((await POST(request({action:'signup',email:'test@example.test',password:'short'}))).status).toBe(400);
    expect(mocks.auth.signUp).not.toHaveBeenCalled();
    expect((await POST(request({action:'login',email:'test@example.test',password:'short'}))).status).toBe(200);
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledWith({email:'test@example.test',password:'short'});
  });
  it('returns a confirmation step instead of fabricating an authenticated signup session',async()=>{
    const response=await POST(request({action:'signup',email:'test@example.test',password:'a-long-test-password',name:'Alex'}));
    expect(response.status).toBe(200);expect(await response.json()).toEqual({data:{message:expect.stringContaining('confirm')}});
    expect(mocks.auth.signUp).toHaveBeenCalledWith(expect.objectContaining({options:{data:{full_name:'Alex'},emailRedirectTo:'https://taskllm.example/auth/callback'}}));
  });
  it('does not expose whether an email exists during password reset',async()=>{
    mocks.auth.resetPasswordForEmail.mockResolvedValueOnce({error:null}).mockResolvedValueOnce({error:{message:'User not found'}});
    const first=await POST(request({action:'reset',email:'known@example.test'}));
    const second=await POST(request({action:'reset',email:'unknown@example.test'}));
    expect(first.status).toBe(200);expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(mocks.auth.resetPasswordForEmail).toHaveBeenCalledWith('known@example.test',{redirectTo:'https://taskllm.example/auth/callback?next=/reset-password'});
  });
  it('requires a verified user before updating a password and sanitizes auth rejection messages',async()=>{
    expect((await POST(request({action:'update-password',password:'a-long-new-password'}))).status).toBe(401);
    expect(mocks.auth.updateUser).not.toHaveBeenCalled();
    mocks.auth.getUser.mockResolvedValue({data:{user:{id:'verified-user'}},error:null});
    expect((await POST(request({action:'update-password',password:'a-long-new-password'}))).status).toBe(200);
    expect(mocks.auth.updateUser).toHaveBeenCalledWith({password:'a-long-new-password'});
    mocks.auth.signInWithPassword.mockResolvedValue({error:{message:'Internal provider detail containing secret'}});
    const rejected=await POST(request({action:'login',email:'test@example.test',password:'password'}));
    expect(rejected.status).toBe(401);expect(JSON.stringify(await rejected.json())).not.toContain('secret');
  });
  it('persists only a hash in the auth rate-limit key and logs out without requiring credentials',async()=>{
    await POST(request({action:'login',email:'private@example.test',password:'password'}));
    const args=mocks.query.mock.calls[0][1] as unknown[];
    expect(String(args[0])).toMatch(/^auth:login:[a-f0-9]{64}$/);expect(String(args[0])).not.toContain('private@example.test');
    const response=await POST(request({action:'logout'}));expect(response.status).toBe(200);expect(await response.json()).toEqual({data:{redirect:'/login'}});
  });
});
