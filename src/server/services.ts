import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import type { PoolClient } from 'pg';
import type { ApiKeySummary, DashboardData, Execution, ExecutionStep, Notification, Plan, Profile, Provider, Schedule, UsageSummary, Workflow, WorkflowGraph } from '@/lib/contracts';
import { validateGraph, nextRun } from '@/lib/workflow';
import { query, transaction } from './db';

export class ServiceError extends Error { constructor(message: string, public status = 400) { super(message); } }
const uuid = z.string().uuid();
function checkId(value: string) { return uuid.parse(value); }
function dto<T>(value: unknown): T { return JSON.parse(JSON.stringify(value)) as T; }
export async function getProfile(userId: string): Promise<Profile> {
 const row = (await query('select * from profiles where id=$1',[checkId(userId)]))[0];
 if (!row) throw new ServiceError('Account profile not found.',404);
 if (row.suspended) throw new ServiceError('This account is suspended.',403);
 return dto<Profile>({...row,spending_cap_micros:Number(row.spending_cap_micros)});
}
export async function getPlan(userId: string, client?: PoolClient): Promise<Plan> {
 const sql = `select p.* from plans p where p.id=coalesce((select plan_id from subscriptions where user_id=$1 and status in ('active','trialing') and current_period_end>now()),'trial')`;
 const row = client ? (await client.query(sql,[userId])).rows[0] : (await query(sql,[userId]))[0];
 if (!row) throw new ServiceError('Plan configuration missing.',503);
 return dto<Plan>({...row,monthly_ai_micros:Number(row.monthly_ai_micros)});
}
async function lockAccount(client: PoolClient,userId:string) {
 const result=await client.query('select * from profiles where id=$1 for update',[checkId(userId)]);
 if(!result.rowCount) throw new ServiceError('Account not found.',404);
 if(result.rows[0].suspended) throw new ServiceError('This account is suspended.',403);
 return result.rows[0];
}
const workflowSql=`select w.*,v.graph from workflows w join workflow_versions v on v.id=w.current_version_id`;
export async function listWorkflows(userId:string):Promise<Workflow[]> {
 await getProfile(userId);
 return dto(await query(`${workflowSql} where w.user_id=$1 order by w.updated_at desc limit 100`,[userId]));
}
export async function getWorkflow(userId:string,id:string):Promise<Workflow> {
 await getProfile(userId);
 const row=(await query(`${workflowSql} where w.user_id=$1 and w.id=$2`,[userId,checkId(id)]))[0];
 if(!row) throw new ServiceError('Workflow not found.',404);
 return dto(row);
}
export async function saveWorkflow(userId:string,input:{id?:string;name:string;description?:string;graph:WorkflowGraph;expected_version_id?:string}):Promise<Workflow> {
 const name=z.string().trim().min(1).max(100).parse(input.name);
 const description=z.string().max(2000).parse(input.description??'');
 const nodes=validateGraph(input.graph);
 if(Buffer.byteLength(JSON.stringify(input.graph),'utf8')>1048576) throw new ServiceError('The complete workflow must be smaller than 1 MiB. Reduce large input data.');
 const id=input.id?checkId(input.id):randomUUID();
 await transaction(async client=>{
  await lockAccount(client,userId); const plan=await getPlan(userId,client);
  if(nodes.length>plan.max_nodes) throw new ServiceError(`Your plan allows ${plan.max_nodes} nodes per workflow.`,402);
  if(nodes.some(node=>node.type==='csv'&&Buffer.byteLength(String(node.config.csv),'utf8')>plan.max_file_bytes)) throw new ServiceError('CSV input exceeds your plan’s file size limit.',402);
  const existing=(await client.query('select * from workflows where id=$1 and user_id=$2 for update',[id,userId])).rows[0];
  if(input.id&&!existing) throw new ServiceError('Workflow not found.',404);
  if(input.expected_version_id&&existing?.current_version_id!==input.expected_version_id) throw new ServiceError('Workflow changed in another tab. Reload before saving.',409);
  if(!existing) {
   const count=Number((await client.query('select count(*) as n from workflows where user_id=$1',[userId])).rows[0].n);
   if(count>=plan.max_workflows) throw new ServiceError('Workflow limit reached for your plan.',402);
   await client.query('insert into workflows(id,user_id,name,description) values($1,$2,$3,$4)',[id,userId,name,description]);
  }
  const version=Number((await client.query('select coalesce(max(version),0)+1 as n from workflow_versions where workflow_id=$1',[id])).rows[0].n);
  const versionId=randomUUID();
  await client.query('insert into workflow_versions(id,workflow_id,user_id,version,graph) values($1,$2,$3,$4,$5)',[versionId,id,userId,version,JSON.stringify(input.graph)]);
  await client.query('update workflows set name=$1,description=$2,current_version_id=$3,updated_at=now() where id=$4 and user_id=$5',[name,description,versionId,id,userId]);
  await client.query('insert into audit_events(user_id,action,resource_id) values($1,$2,$3)',[userId,'workflow.saved',id]);
 });
 return getWorkflow(userId,id);
}
export async function deleteWorkflow(userId:string,id:string):Promise<void> {
 await transaction(async client=>{
  await lockAccount(client,userId);
  const busy=await client.query("select 1 from executions where user_id=$1 and workflow_id=$2 and status in ('queued','running') limit 1",[userId,checkId(id)]);
  if(busy.rowCount) throw new ServiceError('Cancel active executions before deleting this workflow.',409);
  const result=await client.query('delete from workflows where user_id=$1 and id=$2',[userId,id]);
  if(!result.rowCount) throw new ServiceError('Workflow not found.',404);
  await client.query('insert into audit_events(user_id,action,resource_id) values($1,$2,$3)',[userId,'workflow.deleted',id]);
 });
}
export async function duplicateWorkflow(userId:string,id:string):Promise<Workflow> {
 const original=await getWorkflow(userId,id);
 return saveWorkflow(userId,{name:`${original.name.slice(0,90)} (copy)`,description:original.description,graph:original.graph});
}
export async function setWorkflowStatus(userId:string,id:string,status:'draft'|'active'|'paused'):Promise<Workflow> {
 z.enum(['draft','active','paused']).parse(status); await getWorkflow(userId,id);
 await query('update workflows set status=$1,updated_at=now() where user_id=$2 and id=$3',[status,userId,id]);
 return getWorkflow(userId,id);
}
export async function enqueueWithClient(client:PoolClient,userId:string,workflowId:string,idempotencyKey:string):Promise<Execution> {
 await lockAccount(client,userId);
 z.string().min(8).max(200).parse(idempotencyKey);
 const previous=(await client.query('select * from executions where user_id=$1 and idempotency_key=$2',[userId,idempotencyKey])).rows[0];
 if(previous) {
  if(previous.workflow_id!==workflowId) throw new ServiceError('Idempotency key was already used for another workflow.',409);
  return dto(previous);
 }
 const workflow=(await client.query(`${workflowSql} where w.user_id=$1 and w.id=$2`,[userId,checkId(workflowId)])).rows[0];
 if(!workflow) throw new ServiceError('Workflow not found.',404);
 const plan=await getPlan(userId,client);
 if(validateGraph(workflow.graph).length>plan.max_nodes) throw new ServiceError('Workflow exceeds this plan’s node limit.',402);
 const month=(await client.query("select date_trunc('month',now() at time zone 'UTC')::date::text as month")).rows[0].month;
 await client.query('insert into usage_limits(user_id,month) values($1,$2) on conflict do nothing',[userId,month]);
 const usage=(await client.query('select * from usage_limits where user_id=$1 and month=$2 for update',[userId,month])).rows[0];
 if(usage.executions>=plan.monthly_executions) throw new ServiceError('Monthly execution limit reached.',402);
 const workflowRuns=Number((await client.query("select count(*) n from executions where user_id=$1 and workflow_id=$2 and created_at>now()-interval '1 hour'",[userId,workflowId])).rows[0].n);
 if(workflowRuns>=60) throw new ServiceError('This workflow reached its hourly limit of 60 runs.',429);
 await client.query('update usage_limits set executions=executions+1 where user_id=$1 and month=$2',[userId,month]);
 const execution=(await client.query('insert into executions(user_id,workflow_id,version_id,idempotency_key,max_duration_seconds,usage_month) values($1,$2,$3,$4,$5,$6) returning *',[userId,workflowId,workflow.current_version_id,idempotencyKey,plan.max_duration_seconds,month])).rows[0];
 await client.query('insert into job_outbox(execution_id) values($1)',[execution.id]);
 return dto(execution);
}
export async function enqueueExecution(userId:string,workflowId:string,idempotencyKey:string):Promise<Execution> { return transaction(client=>enqueueWithClient(client,userId,workflowId,idempotencyKey)); }
function executionDto(row:Record<string,unknown>):Execution { return dto({...row,cost_micros:Number(row.cost_micros),input_tokens:Number(row.input_tokens),output_tokens:Number(row.output_tokens)}); }
export async function listExecutions(userId:string,options:{page?:number;search?:string;status?:string}={}) {
 await getProfile(userId); const page=Math.max(1,Math.min(100000,Math.floor(options.page??1))); const pageSize=20;
 const status=options.status&&options.status!=='all'?z.enum(['queued','running','completed','failed','cancelled']).parse(options.status):null;
 const search=z.string().max(100).parse(options.search??'');
 const params=[userId,status,`%${search.replace(/[\\%_]/g,'\\$&')}%`];
 const where="where e.user_id=$1 and ($2::text is null or e.status=$2) and w.name ilike $3";
 const [items,count]=await Promise.all([
  query(`select e.*,w.name workflow_name from executions e join workflows w on w.id=e.workflow_id ${where} order by e.created_at desc limit 20 offset $4`,[...params,(page-1)*pageSize]),
  query(`select count(*) n from executions e join workflows w on w.id=e.workflow_id ${where}`,params)
 ]);
 return {items:items.map(executionDto),total:Number(count[0].n),page,pageSize};
}
export async function getExecution(userId:string,id:string):Promise<{execution:Execution;steps:ExecutionStep[]}> {
 await getProfile(userId);
 const row=(await query('select e.*,w.name workflow_name from executions e join workflows w on w.id=e.workflow_id where e.user_id=$1 and e.id=$2',[userId,checkId(id)]))[0];
 if(!row) throw new ServiceError('Execution not found.',404);
 const steps=await query('select node_id,status,output,error,started_at,finished_at,attempts,provider,model,input_tokens,output_tokens,cost_micros from execution_steps where execution_id=$1 and user_id=$2 order by started_at',[id,userId]);
 return {execution:executionDto(row),steps:dto(steps.map(s=>({...s,input_tokens:Number(s.input_tokens),output_tokens:Number(s.output_tokens),cost_micros:Number(s.cost_micros)})))};
}
export async function cancelExecution(userId:string,id:string):Promise<void> {
 await getExecution(userId,id);
 await query("update executions set cancel_requested=true,status=case when status='queued' then 'cancelled' else status end,finished_at=case when status='queued' then now() else finished_at end where user_id=$1 and id=$2 and status in ('queued','running')",[userId,id]);
}
export async function listSchedules(userId:string):Promise<Schedule[]> {
 await getProfile(userId);
 return dto(await query('select s.*,w.name workflow_name from schedules s join workflows w on w.id=s.workflow_id where s.user_id=$1 order by s.next_run_at nulls last limit 100',[userId]));
}
export async function saveSchedule(userId:string,input:{id?:string;workflow_id:string;cron?:string|null;timezone:string;run_at?:string;ends_at?:string|null}):Promise<Schedule> {
 await getWorkflow(userId,input.workflow_id);
 const timezone=z.string().min(1).max(100).parse(input.timezone); try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { throw new ServiceError('Invalid timezone.'); }
 const cron=input.cron?z.string().max(100).parse(input.cron):null;
 const now=new Date(); const next=cron?nextRun(cron,timezone,now):new Date(z.iso.datetime({offset:true}).parse(input.run_at));
 if(next<=now) throw new ServiceError('Choose a future date.');
 const ends=input.ends_at?new Date(z.iso.datetime({offset:true}).parse(input.ends_at)):null;
 if(ends&&ends<next) throw new ServiceError('End date precedes the first run.');
 // Checking only the next two dates misses a clustered minute list after a long gap.
 if(cron&&(CronExpressionParser.parse(cron,{currentDate:now,tz:timezone}).fields.minute.values.length!==1||nextRun(cron,timezone,next).getTime()-next.getTime()<3600000)) throw new ServiceError('Schedules must be at least one hour apart. Choose one minute within the hour.');
 return transaction(async client=>{
  await lockAccount(client,userId);
  const existing=(await client.query('select count(*) n from schedules where user_id=$1',[userId])).rows[0];
  if(!input.id&&Number(existing.n)>=100) throw new ServiceError('Schedule limit reached.',402);
  let rows;
  if(input.id) rows=(await client.query('update schedules set workflow_id=$1,cron=$2,timezone=$3,next_run_at=$4,ends_at=$5,enabled=true where id=$6 and user_id=$7 returning *',[input.workflow_id,cron,timezone,next,ends,checkId(input.id),userId])).rows;
  else rows=(await client.query('insert into schedules(user_id,workflow_id,cron,timezone,next_run_at,ends_at) values($1,$2,$3,$4,$5,$6) returning *',[userId,input.workflow_id,cron,timezone,next,ends])).rows;
  if(!rows.length) throw new ServiceError('Schedule not found.',404);
  await client.query("update workflows set status='active' where id=$1 and user_id=$2",[input.workflow_id,userId]);
  return dto<Schedule>(rows[0]);
 });
}
export async function toggleSchedule(userId:string,id:string,enabled:boolean):Promise<void> {
 z.boolean().parse(enabled); await getProfile(userId);
 await transaction(async client=>{
  const row=(await client.query('select * from schedules where id=$1 and user_id=$2 for update',[checkId(id),userId])).rows[0];
  if(!row) throw new ServiceError('Schedule not found.',404);
  let next=row.next_run_at;
  if(enabled&&(!next||new Date(next)<=new Date())) {
   if(!row.cron) throw new ServiceError('Reschedule this one-time run before enabling it.');
   next=nextRun(row.cron,row.timezone,new Date());
  }
  if(enabled&&row.ends_at&&new Date(row.ends_at)<new Date(next)) throw new ServiceError('This schedule has ended.');
  await client.query('update schedules set enabled=$1,next_run_at=$2 where id=$3 and user_id=$4',[enabled,next,id,userId]);
 });
}
export async function deleteSchedule(userId:string,id:string):Promise<void> {
 await getProfile(userId); await query('delete from schedules where id=$1 and user_id=$2',[checkId(id),userId]);
}
export async function getUsage(userId:string):Promise<UsageSummary> {
 await getProfile(userId);
 const period="user_id=$1 and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'";
 const [total,daily,models,workflows]=await Promise.all([
  query(`select coalesce(sum(input_tokens),0) input_tokens,coalesce(sum(output_tokens),0) output_tokens,coalesce(sum(cost_micros) filter(where billing_mode='managed'),0) managed_cost_micros,coalesce(sum(cost_micros) filter(where billing_mode='byok'),0) byok_cost_micros,count(*) requests from ai_usage where ${period}`,[userId]),
  query(`select to_char(created_at at time zone 'UTC','YYYY-MM-DD') date,count(*) requests,sum(cost_micros) cost_micros,sum(input_tokens+output_tokens) tokens from ai_usage where ${period} group by 1 order by 1`,[userId]),
  query(`select model,count(*) requests,sum(cost_micros) cost_micros,sum(input_tokens+output_tokens) tokens from ai_usage where ${period} group by model order by cost_micros desc`,[userId]),
  query(`select w.name,count(*) requests,sum(a.cost_micros) cost_micros,sum(a.input_tokens+a.output_tokens) tokens from ai_usage a join workflows w on w.id=a.workflow_id where a.user_id=$1 and a.created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' group by w.id,w.name order by cost_micros desc`,[userId])
 ]);
 const convert=(rows:Record<string,unknown>[])=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,['requests','cost_micros','tokens'].includes(k)?Number(v):v])));
 return dto({...Object.fromEntries(Object.entries(total[0]).map(([k,v])=>[k,Number(v)])),daily:convert(daily),by_model:convert(models),by_workflow:convert(workflows)});
}
export async function getDashboard(userId:string):Promise<DashboardData> {
 const [counts,executions,recent,upcoming,usage,plan]=await Promise.all([
  query("select count(*) total,count(*) filter(where status='active') active from workflows where user_id=$1",[userId]),
  query("select count(*) total,count(*) filter(where status='completed') completed,count(*) filter(where status in ('completed','failed')) terminal from executions where user_id=$1 and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'",[userId]),
  listExecutions(userId),listSchedules(userId),getUsage(userId),getPlan(userId)
 ]);
 return {total_workflows:Number(counts[0].total),active_workflows:Number(counts[0].active),monthly_executions:Number(executions[0].total),success_rate:Number(executions[0].terminal)?Math.round(Number(executions[0].completed)/Number(executions[0].terminal)*100):null,recent_executions:recent.items.slice(0,6),upcoming_runs:upcoming.filter(s=>s.enabled).slice(0,5),usage,plan};
}
const profileUpdate=z.object({full_name:z.string().trim().max(100).optional(),timezone:z.string().max(100).optional(),default_provider:z.enum(['openai','anthropic']).optional(),default_model:z.string().max(100).optional(),notify_completed:z.boolean().optional(),notify_failed:z.boolean().optional(),spending_cap_micros:z.number().int().min(0).max(1000000000).optional()}).strict();
export async function updateProfile(userId:string,input:unknown):Promise<Profile> {
 await getProfile(userId); const data=profileUpdate.parse(input);
 if(data.timezone) try {new Intl.DateTimeFormat('en',{timeZone:data.timezone});} catch {throw new ServiceError('Invalid timezone.');}
 const entries=Object.entries(data); if(entries.length) await query(`update profiles set ${entries.map(([k],i)=>`${k}=$${i+2}`).join(',')} where id=$1`,[userId,...entries.map(([,v])=>v)]);
 return getProfile(userId);
}
export async function listApiKeys(userId:string):Promise<ApiKeySummary[]> { await getProfile(userId); return dto(await query('select id,provider,last_four,status,created_at from api_keys where user_id=$1 order by provider',[userId])); }
export async function storeApiKey(userId:string,input:{provider:Provider;encrypted_key:string;last_four:string;status?:string}):Promise<void> {
 await getProfile(userId);
 await query('insert into api_keys(user_id,provider,encrypted_key,last_four,status) values($1,$2,$3,$4,$5) on conflict(user_id,provider) do update set encrypted_key=excluded.encrypted_key,last_four=excluded.last_four,status=excluded.status,created_at=now()',[userId,z.enum(['openai','anthropic']).parse(input.provider),input.encrypted_key,z.string().length(4).parse(input.last_four),input.status??'untested']);
 await query('insert into audit_events(user_id,action,resource_id) values($1,$2,$3)',[userId,'api_key.saved',input.provider]);
}
export async function removeApiKey(userId:string,id:string):Promise<void> { await getProfile(userId); await query('delete from api_keys where id=$1 and user_id=$2',[checkId(id),userId]); }
export async function listNotifications(userId:string):Promise<Notification[]> { await getProfile(userId); return dto(await query('select id,title,body,read_at,created_at from notifications where user_id=$1 order by created_at desc limit 50',[userId])); }
export async function markNotification(userId:string,id:string):Promise<void> { await getProfile(userId); await query('update notifications set read_at=coalesce(read_at,now()) where id=$1 and user_id=$2',[checkId(id),userId]); }
export async function getSubscription(userId:string) { await getProfile(userId); return dto((await query('select plan_id,status,current_period_end,cancel_at_period_end from subscriptions where user_id=$1',[userId]))[0]??{plan_id:'trial',status:'inactive',current_period_end:null,cancel_at_period_end:false}); }
export async function getAdminOverview(userId:string) {
 const profile=await getProfile(userId); if(!profile.is_admin) throw new ServiceError('Administrator access required.',403);
 const [stats]=await query("select (select count(*) from profiles) total_users,(select count(*) from subscriptions where status in ('active','trialing') and current_period_end>now()) active_subscriptions,(select count(*) from workflows) total_workflows,(select count(*) from executions) executions,(select count(*) from executions where status='failed') failed_jobs,(select coalesce(sum(cost_micros),0) from ai_usage where billing_mode='managed') api_cost_micros,(select count(*) from job_outbox where dispatched_at is null) pending_jobs");
 return Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,Number(v)]));
}
export async function rateLimit(key:string,maxHits:number,windowSeconds:number):Promise<void> {
 const rows=await query(`insert into rate_limits(key,window_start,hits) values($1,now(),1) on conflict(key) do update set hits=case when rate_limits.window_start<now()-($2*interval '1 second') then 1 else rate_limits.hits+1 end,window_start=case when rate_limits.window_start<now()-($2*interval '1 second') then now() else rate_limits.window_start end returning hits`,[key,windowSeconds]);
 if(rows[0].hits>maxHits) throw new ServiceError('Too many requests. Please try again later.',429);
}
