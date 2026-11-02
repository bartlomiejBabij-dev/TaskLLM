import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import type { WorkflowGraph,WorkflowNode,AiResult } from '../src/lib/contracts';

const state=vi.hoisted(()=>({db:null as unknown as PGlite,callAI:vi.fn()}));
vi.mock('../src/server/db',()=>({
 query:async(sql:string,params:unknown[]=[]) => (await state.db.query(sql,params)).rows,
 transaction:async(fn:(client:unknown)=>Promise<unknown>)=>state.db.transaction(async client=>fn({query:async(sql:string,params:unknown[]=[])=>{const r=await client.query(sql,params);return {...r,rowCount:Math.max(r.affectedRows??0,r.rows.length)};}})),
 getDb:()=>({connect:async()=>({query:async(sql:string,params:unknown[]=[])=>{const r=await state.db.query(sql,params);return {...r,rowCount:Math.max(r.affectedRows??0,r.rows.length)};},release:()=>{}})})
}));
vi.mock('../src/lib/ai',async()=>({...await vi.importActual<typeof import('../src/lib/ai')>('../src/lib/ai'),callAI:state.callAI}));
import { ProviderError } from '../src/lib/ai';
import { processExecution,AccountBusyError,MAX_WORKER_ATTEMPTS } from '../src/server/execution';
import { saveWorkflow,enqueueExecution,getExecution,cancelExecution,storeApiKey,getUsage } from '../src/server/services';
import { encryptSecret } from '../src/lib/security/secrets';

const alice='11111111-1111-4111-8111-111111111111';
const root:WorkflowNode={id:'start',name:'Start',type:'manual',position:{x:0,y:0},config:{}};
const input:WorkflowNode={id:'input',name:'Input',type:'text',position:{x:200,y:0},config:{text:'  Initial data  '}};
const transform:WorkflowNode={id:'trim',name:'Trim',type:'transform',position:{x:400,y:0},config:{input:'{{steps.input.output}}',operation:'trim'}};
const save:WorkflowNode={id:'save',name:'Save',type:'save',position:{x:800,y:0},config:{input:'{{steps.trim.output}}'}};
const ai:WorkflowNode={id:'analysis',name:'Analyze',type:'ai',position:{x:400,y:0},config:{provider:'openai',model:'gpt-6-luna',prompt:'Analyze supplied data',input:'{{steps.input.output}}',maxOutputTokens:64,billingMode:'byok'}};
const review:WorkflowNode={...ai,id:'review',name:'Review',position:{x:600,y:0},config:{...ai.config,prompt:'Review the analysis',input:'{{steps.analysis.output}}'}};
function chain(nodes:WorkflowNode[]):WorkflowGraph {return {nodes:structuredClone(nodes),edges:nodes.slice(1).map((node,i)=>({id:`edge_${i}`,source:nodes[i].id,target:node.id}))};}
const answer=(text='Actual test provider response'):AiResult=>({text,model:'gpt-6-luna',inputTokens:12,outputTokens:20,costMicros:12,durationMs:20});
async function createRun(graph:WorkflowGraph) {const workflow=await saveWorkflow(alice,{name:'Engine integration',graph});return enqueueExecution(alice,workflow.id,crypto.randomUUID());}
async function getUsageLimits() {return (await state.db.query<Record<string,number>>('select * from usage_limits where user_id=$1',[alice])).rows[0];}

beforeAll(async()=>{
 state.db=new PGlite();
 await state.db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to authenticated,anon;`);
 await state.db.exec(await readFile('supabase/migrations/0001_initial.sql','utf8'));
});
afterAll(async()=>{await state.db.close();});
beforeEach(async()=>{
 vi.clearAllMocks();state.callAI.mockReset();state.callAI.mockResolvedValue(answer());
 vi.stubEnv('ENCRYPTION_KEY',Buffer.alloc(32,7).toString('base64'));
 vi.stubEnv('OPENAI_API_KEY','test-managed-key-never-sent');
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected live network call in integration test');}));
 await state.db.exec('reset role;truncate auth.users cascade;');
 await state.db.query('insert into auth.users(id,email) values($1,$2)',[alice,'alice@example.test']);
 await storeApiKey(alice,{provider:'openai',encrypted_key:encryptSecret('test-byok-key-never-sent',`${alice}:openai`),last_four:'sent'});
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('Execution engine with real PostgreSQL and explicitly mocked external providers',()=>{
 it('executes connected pure steps using the immutable queued version and persists every result',async()=>{
  const run=await createRun(chain([root,input,transform,save]));
  const changed=chain([root,{...input,config:{text:'New version'}},transform,save]);
  await saveWorkflow(alice,{id:run.workflow_id,name:'Edited while queued',graph:changed});
  await processExecution(run.id);
  const result=await getExecution(alice,run.id);
  expect(result.execution.status).toBe('completed');expect(result.execution.result).toBe('Initial data');
  expect(result.steps).toHaveLength(4);expect(result.steps.every(step=>step.status==='completed')).toBe(true);
  await processExecution(run.id);
  expect((await getExecution(alice,run.id)).steps.every(step=>step.attempts===1)).toBe(true);
  expect((await state.db.query('select * from notifications')).rows).toHaveLength(1);
 });
 it('passes the first AI result into the next provider call and accounts for two calls only once',async()=>{
  state.callAI.mockResolvedValueOnce(answer('First analysis')).mockResolvedValueOnce(answer('Reviewed summary'));
  const run=await createRun(chain([root,input,ai,review,{...save,config:{input:'{{steps.review.output}}'}}]));
  await processExecution(run.id);await processExecution(run.id);
  expect(state.callAI).toHaveBeenCalledTimes(2);
  expect(state.callAI.mock.calls[1][0].input).toBe('First analysis');
  const result=await getExecution(alice,run.id);
  expect(result.execution.status).toBe('completed');expect(result.execution.result).toBe('Reviewed summary');
  expect(result.execution.cost_micros).toBe(24);expect(result.execution.input_tokens).toBe(24);
  expect((await getUsage(alice)).requests).toBe(2);expect(Number((await getUsageLimits()).byok_reserved_micros)).toBe(0);
 });
 it('refuses managed calls with no entitlement before contacting the provider',async()=>{
  const run=await createRun(chain([root,input,{...ai,config:{...ai.config,billingMode:'managed'}}]));
  await processExecution(run.id);
  expect(state.callAI).not.toHaveBeenCalled();
  const {execution}=await getExecution(alice,run.id);expect(execution.status).toBe('failed');expect(execution.error).toContain('Managed AI budget');
  expect(Number((await getUsageLimits()).managed_reserved_micros)).toBe(0);
 });
 it('refuses a request exceeding the account spending cap before contacting the provider',async()=>{
  await state.db.query('update profiles set spending_cap_micros=1 where id=$1',[alice]);
  const run=await createRun(chain([root,input,ai]));await processExecution(run.id);
  expect(state.callAI).not.toHaveBeenCalled();expect((await getExecution(alice,run.id)).execution.error).toContain('spending cap');
 });
 it('retains the reservation and never automatically repeats an ambiguous paid request',async()=>{
  state.callAI.mockRejectedValue(new ProviderError('Connection interrupted; billing status is uncertain.',502,false));
  const run=await createRun(chain([root,input,ai]));await processExecution(run.id);await processExecution(run.id);
  const result=await getExecution(alice,run.id);expect(result.execution.status).toBe('failed');
  expect(result.steps.find(step=>step.node_id==='analysis')?.status).toBe('uncertain');expect(state.callAI).toHaveBeenCalledTimes(1);
  expect(Number((await getUsageLimits()).byok_reserved_micros)).toBeGreaterThan(0);expect((await getUsage(alice)).requests).toBe(0);
 });
 it('releases reservations for definitive authentication rejection',async()=>{
  state.callAI.mockRejectedValue(new ProviderError('The API key is invalid.',401,false));
  const run=await createRun(chain([root,input,ai]));await processExecution(run.id);
  expect(Number((await getUsageLimits()).byok_reserved_micros)).toBe(0);
  expect((await getExecution(alice,run.id)).steps.find(step=>step.node_id==='analysis')?.status).toBe('failed');
 });
 it('resumes saved pure checkpoints without replay and refuses an interrupted external checkpoint',async()=>{
  const run=await createRun(chain([root,input,ai]));
  await state.db.query("insert into execution_steps(execution_id,user_id,node_id,status,output,finished_at) values($1,$2,'start','completed','{}',now()),($1,$2,'input','completed',$3,now())",[run.id,alice,JSON.stringify('Persisted input')]);
  await state.db.query("insert into execution_steps(execution_id,user_id,node_id,status,provider,model) values($1,$2,'analysis','running','openai','gpt-6-luna')",[run.id,alice]);
  await processExecution(run.id);
  expect(state.callAI).not.toHaveBeenCalled();expect((await getExecution(alice,run.id)).execution.error).toContain('interrupted');
  expect((await getExecution(alice,run.id)).steps.find(step=>step.node_id==='input')?.attempts).toBe(1);
 });
 it('cancels queued runs before creating any step or provider request',async()=>{
  const run=await createRun(chain([root,input,ai]));await cancelExecution(alice,run.id);await processExecution(run.id);
  const result=await getExecution(alice,run.id);expect(result.execution.status).toBe('cancelled');expect(result.steps).toHaveLength(0);expect(state.callAI).not.toHaveBeenCalled();
 });
 it('records cancellation during a paid request as cancelled while keeping uncertain cost reserved',async()=>{
  const run=await createRun(chain([root,input,ai]));
  state.callAI.mockImplementation(async(_request:unknown,_key:string,signal:AbortSignal)=>{
   await cancelExecution(alice,run.id);
   await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
   throw new ProviderError('Execution was cancelled.',499,false);
  });
  await processExecution(run.id);
  expect((await getExecution(alice,run.id)).execution.status).toBe('cancelled');expect(Number((await getUsageLimits()).byok_reserved_micros)).toBeGreaterThan(0);
 });
 it('bounds worker recovery attempts independently of Redis job history',async()=>{
  const run=await createRun(chain([root,input,ai]));
  await state.db.query('update executions set worker_attempts=$1 where id=$2',[MAX_WORKER_ATTEMPTS,run.id]);await processExecution(run.id);
  expect((await getExecution(alice,run.id)).execution.error).toContain('recovery limit');expect(state.callAI).not.toHaveBeenCalled();
 });
 it('defers work when this account already has a live execution',async()=>{
  const first=await createRun(chain([root,input,transform,save]));const next=await enqueueExecution(alice,first.workflow_id,'concurrent-execution');
  await state.db.query("update executions set status='running',heartbeat_at=now() where id=$1",[first.id]);
  await expect(processExecution(next.id)).rejects.toBeInstanceOf(AccountBusyError);
  const row=(await state.db.query<{status:string;worker_attempts:number}>('select status,worker_attempts from executions where id=$1',[next.id])).rows[0];
  expect(row.status).toBe('queued');expect(row.worker_attempts).toBe(0);
 });
 it('stops suspended accounts without running external nodes',async()=>{
  const run=await createRun(chain([root,input,ai]));await state.db.query('update profiles set suspended=true where id=$1',[alice]);await processExecution(run.id);
  const row=(await state.db.query<{status:string;error:string}>('select status,error from executions where id=$1',[run.id])).rows[0];expect(row.status).toBe('failed');expect(row.error).toContain('suspended');expect(state.callAI).not.toHaveBeenCalled();
 });
 it('sends email with a stable provider idempotency key and does not resend on job replay',async()=>{
  vi.stubEnv('RESEND_API_KEY','test-resend-key');vi.stubEnv('RESEND_FROM','TaskLLM <noreply@example.test>');
  const send=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'mock-resend-message'}),{status:200}));vi.stubGlobal('fetch',send);
  const email:WorkflowNode={id:'email',name:'Email',type:'email',position:{x:400,y:0},config:{to:'alice@example.test',subject:'Report',body:'{{steps.input.output}}'}};
  const run=await createRun(chain([root,input,email]));await processExecution(run.id);await processExecution(run.id);
  expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][1].headers['Idempotency-Key']).toBe(`taskllm-${run.id}-email`);
  expect((await getExecution(alice,run.id)).execution.result).toEqual({messageId:'mock-resend-message',accepted:true});
 });
});
