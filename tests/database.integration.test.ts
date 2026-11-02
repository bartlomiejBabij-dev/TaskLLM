import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '../src/lib/contracts';

const state=vi.hoisted(()=>({db:null as unknown as PGlite}));
vi.mock('../src/server/db',()=>({
 query:async(sql:string,params:unknown[]=[]) => (await state.db.query(sql,params)).rows,
 transaction:async(fn:(client:unknown)=>Promise<unknown>)=>state.db.transaction(async client=>fn({query:async(sql:string,params:unknown[]=[])=>{const r=await client.query(sql,params);return {...r,rowCount:Math.max(r.affectedRows??0,r.rows.length)};}})),
 getDb:()=>({connect:async()=>{throw new Error('Not used by service tests');}})
}));
import { saveWorkflow, getWorkflow, enqueueExecution, getExecution, getPlan, updateProfile, getUsage, saveSchedule, cancelExecution, deleteWorkflow } from '../src/server/services';
import { reserveStep, settleAiStep } from '../src/server/execution';
import { dispatchOutbox,dispatchSchedules } from '../src/worker/dispatcher';

const alice='11111111-1111-4111-8111-111111111111';
const bob='22222222-2222-4222-8222-222222222222';
const graph:WorkflowGraph={nodes:[
 {id:'start',type:'manual',name:'Manual trigger',position:{x:0,y:0},config:{}},
 {id:'input',type:'text',name:'Text input',position:{x:200,y:0},config:{text:'Hello'}},
 {id:'result',type:'save',name:'Save result',position:{x:400,y:0},config:{input:'{{steps.input.output}}'}}
],edges:[{id:'a',source:'start',target:'input'},{id:'b',source:'input',target:'result'}]};

beforeAll(async()=>{
 state.db=new PGlite();
 await state.db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to authenticated,anon;`);
 await state.db.exec(await readFile('supabase/migrations/0001_initial.sql','utf8'));
});
afterAll(async()=>{await state.db.close();});
beforeEach(async()=>{
 await state.db.exec('reset role;truncate auth.users cascade;');
 await state.db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[alice,'alice@example.test',bob,'bob@example.test']);
});

describe('PostgreSQL schema and tenant isolation (real PGlite engine)',()=>{
 it('creates least-privilege profiles and prevents users reading another account or encrypted keys',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Private',graph});
  await state.db.query("insert into api_keys(user_id,provider,encrypted_key,last_four) values($1,'openai','ciphertext','1234')",[alice]);
  await state.db.exec(`set role authenticated;set request.jwt.claim.sub='${bob}';`);
  expect((await state.db.query('select * from workflows')).rows).toHaveLength(0);
  expect((await state.db.query('select * from workflow_nodes')).rows).toHaveLength(0);
  await expect(state.db.query('select * from api_keys')).rejects.toThrow(/permission denied/);
  await expect(state.db.query('update profiles set is_admin=true where id=$1',[bob])).rejects.toThrow(/permission denied/);
  await state.db.exec(`set request.jwt.claim.sub='${alice}';`);
  expect((await state.db.query('select * from workflows')).rows).toHaveLength(1);
  expect((await state.db.query('select * from workflow_nodes')).rows).toHaveLength(3);
  await state.db.exec('reset role');
  await expect(getWorkflow(bob,workflow.id)).rejects.toThrow('not found');
 });
 it('rejects cross-tenant references at the database layer',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Private',graph});
  await expect(state.db.query('insert into schedules(user_id,workflow_id,next_run_at) values($1,$2,now())',[bob,workflow.id])).rejects.toThrow(/foreign key/);
 });
 it('runs an immutable saved version even after the workflow is edited',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Versioned',graph});
  const execution=await enqueueExecution(alice,workflow.id,'version-test-key');
  const updated=structuredClone(graph);updated.nodes[1].config.text='Changed';
  await saveWorkflow(alice,{id:workflow.id,name:'Edited',graph:updated});
  const version=await state.db.query<{graph:WorkflowGraph}>('select v.graph from executions e join workflow_versions v on v.id=e.version_id where e.id=$1',[execution.id]);
  expect(version.rows[0].graph.nodes[1].config.text).toBe('Hello');
  await expect(state.db.query("update workflow_versions set graph='{}' where id=$1",[workflow.current_version_id])).rejects.toThrow('immutable');
 });
 it('prevents stale editor writes when an expected version is provided',async()=>{
  const workflow=await saveWorkflow(alice,{name:'First',graph});
  await saveWorkflow(alice,{id:workflow.id,name:'Second',graph});
  await expect(saveWorkflow(alice,{id:workflow.id,name:'Stale',graph,expected_version_id:workflow.current_version_id!})).rejects.toThrow('another tab');
 });
 it('does not trust entitlement-like profile updates or inactive subscriptions',async()=>{
  await expect(updateProfile(alice,{is_admin:true})).rejects.toThrow();
  await state.db.query("insert into subscriptions(user_id,plan_id,status,current_period_end) values($1,'pro','past_due',now()+interval '1 month')",[alice]);
  expect((await getPlan(alice)).id).toBe('trial');
  await state.db.query("update subscriptions set status='active' where user_id=$1",[alice]);
  expect((await getPlan(alice)).id).toBe('pro');
 });
});

describe('Transactional execution limits, dedupe and accounting',()=>{
 it('deduplicates enqueue and outbox without consuming a second monthly execution',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Run',graph});
  const first=await enqueueExecution(alice,workflow.id,'same-run-idempotency');
  const second=await enqueueExecution(alice,workflow.id,'same-run-idempotency');
  expect(first.id).toBe(second.id);
  expect((await state.db.query<{executions:number}>('select executions from usage_limits')).rows[0].executions).toBe(1);
  expect((await state.db.query('select * from job_outbox')).rows).toHaveLength(1);
  await expect(enqueueExecution(bob,workflow.id,'other-user-attempt')).rejects.toThrow('not found');
 });
 it('enforces the monthly cap atomically and rolls back rejected requests',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Limit',graph});
  await state.db.query("insert into usage_limits(user_id,month,executions) values($1,date_trunc('month',now() at time zone 'UTC')::date,25)",[alice]);
  await expect(enqueueExecution(alice,workflow.id,'over-the-limit')).rejects.toThrow('Monthly execution limit');
  expect((await state.db.query('select * from executions')).rows).toHaveLength(0);
 });
 it('reserves maximum cost before AI and settles each step once',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Accounting',graph});
  const exec=await enqueueExecution(alice,workflow.id,'accounting-run');
  const run=(await state.db.query('select e.*,v.graph from executions e join workflow_versions v on v.id=e.version_id where e.id=$1',[exec.id])).rows[0];
  const node={id:'ai',type:'ai' as const,name:'AI',position:{x:0,y:0},config:{}};
  const request={provider:'openai' as const,model:'gpt-6-luna',prompt:'hello',maxOutputTokens:64};
  await expect(reserveStep(run as never,node,request,'managed')).rejects.toThrow('Managed AI budget');
  const reserved=await reserveStep(run as never,node,request,'byok');
  expect(reserved).toBeGreaterThan(0);
  await expect(reserveStep(run as never,node,request,'byok')).rejects.toThrow('already started');
  const result={text:'Hello',model:'gpt-6-luna',inputTokens:10,outputTokens:10,costMicros:6,durationMs:20};
  await settleAiStep(run as never,node,request,'byok',result);
  await settleAiStep(run as never,node,request,'byok',result);
  const usage=await getUsage(alice);
  expect(usage.requests).toBe(1);expect(usage.byok_cost_micros).toBe(6);expect(usage.managed_cost_micros).toBe(0);
  const limits=(await state.db.query<{byok_reserved_micros:number;byok_spent_micros:number}>('select * from usage_limits')).rows[0];
  expect(Number(limits.byok_reserved_micros)).toBe(0);expect(Number(limits.byok_spent_micros)).toBe(6);
 });
 it('enforces an account cap including outstanding reservations',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Cap',graph});
  const exec=await enqueueExecution(alice,workflow.id,'spending-cap-run');
  const run=(await state.db.query('select e.*,v.graph from executions e join workflow_versions v on v.id=e.version_id where e.id=$1',[exec.id])).rows[0];
  await updateProfile(alice,{spending_cap_micros:1});
  await expect(reserveStep(run as never,{id:'ai',type:'ai',name:'AI',position:{x:0,y:0},config:{}},{provider:'openai',model:'gpt-6-luna',prompt:'Hello',maxOutputTokens:64},'byok')).rejects.toThrow('spending cap');
  expect((await state.db.query('select * from execution_steps')).rows).toHaveLength(0);
 });
 it('cancels queued work and protects ownership of results',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Cancel',graph});
  const execution=await enqueueExecution(alice,workflow.id,'cancel-this-run');
  await expect(cancelExecution(bob,execution.id)).rejects.toThrow('not found');
  await expect(deleteWorkflow(alice,workflow.id)).rejects.toThrow('Cancel active');
  await cancelExecution(alice,execution.id);
  expect((await getExecution(alice,execution.id)).execution.status).toBe('cancelled');
  await deleteWorkflow(alice,workflow.id);
  expect((await state.db.query('select * from workflows')).rows).toHaveLength(0);
 });
 it('validates schedules and limits minimum frequency on the server',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Scheduled',graph});
  await expect(saveSchedule(alice,{workflow_id:workflow.id,cron:'* * * * *',timezone:'Europe/Warsaw'})).rejects.toThrow('one hour');
  await expect(saveSchedule(alice,{workflow_id:workflow.id,cron:'0,1 9 * * *',timezone:'Europe/Warsaw'})).rejects.toThrow('one hour');
  await expect(saveSchedule(bob,{workflow_id:workflow.id,cron:'0 9 * * *',timezone:'Europe/Warsaw'})).rejects.toThrow('not found');
  const scheduled=await saveSchedule(alice,{workflow_id:workflow.id,cron:'0 9 * * *',timezone:'Europe/Warsaw'});
  expect(scheduled.enabled).toBe(true);expect(new Date(scheduled.next_run_at!).getTime()).toBeGreaterThan(Date.now());
 });
 it('dispatches a one-time slot once, even when the scheduler runs repeatedly',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Once',graph});
  const schedule=await saveSchedule(alice,{workflow_id:workflow.id,timezone:'Europe/Warsaw',run_at:new Date(Date.now()+3600000).toISOString()});
  await state.db.query("update schedules set next_run_at=now()-interval '1 minute' where id=$1",[schedule.id]);
  await dispatchSchedules();await dispatchSchedules();
  expect((await state.db.query('select * from executions')).rows).toHaveLength(1);
  expect((await state.db.query<{enabled:boolean}>('select enabled from schedules')).rows[0].enabled).toBe(false);
  expect((await state.db.query('select * from job_outbox')).rows).toHaveLength(1);
 });
 it('coalesces missed recurring slots and ignores paused workflows',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Recurring',graph});
  const schedule=await saveSchedule(alice,{workflow_id:workflow.id,cron:'0 9 * * *',timezone:'Europe/Warsaw'});
  await state.db.query("update schedules set next_run_at=now()-interval '10 days' where id=$1",[schedule.id]);
  await state.db.query("update workflows set status='paused' where id=$1",[workflow.id]);await dispatchSchedules();
  expect((await state.db.query('select * from executions')).rows).toHaveLength(0);
  await state.db.query("update workflows set status='active' where id=$1",[workflow.id]);await dispatchSchedules();await dispatchSchedules();
  expect((await state.db.query('select * from executions')).rows).toHaveLength(1);
  const updated=(await state.db.query<{next_run_at:string}>('select next_run_at from schedules')).rows[0];expect(new Date(updated.next_run_at).getTime()).toBeGreaterThan(Date.now());
 });
 it('leaves durable job intent pending when Redis dispatch fails',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Outbox',graph});await enqueueExecution(alice,workflow.id,'redis-unavailable-test');
  const queue={add:vi.fn().mockRejectedValue(new Error('Redis unavailable')),getJob:vi.fn()};
  await expect(dispatchOutbox(queue)).rejects.toThrow('Redis unavailable');
  const outbox=(await state.db.query<{dispatched_at:string|null;attempts:number}>('select * from job_outbox')).rows[0];
  expect(outbox.dispatched_at).toBeNull();expect(outbox.attempts).toBe(0);
  expect((await state.db.query<{status:string}>('select status from executions')).rows[0].status).toBe('queued');
 });
 it('fails exhausted queue jobs instead of resetting their retry counter',async()=>{
  const workflow=await saveWorkflow(alice,{name:'Bounded retries',graph});const run=await enqueueExecution(alice,workflow.id,'exhausted-job-test');
  await state.db.query('update job_outbox set dispatched_at=now() where execution_id=$1',[run.id]);
  const retry=vi.fn();const queue={add:vi.fn(),getJob:vi.fn().mockResolvedValue({isFailed:async()=>true,retry})};
  await dispatchOutbox(queue);await dispatchOutbox(queue);
  expect(retry).not.toHaveBeenCalled();expect(queue.add).not.toHaveBeenCalled();
  expect((await getExecution(alice,run.id)).execution.status).toBe('failed');
  expect((await state.db.query('select * from execution_logs')).rows).toHaveLength(1);
 });
});
