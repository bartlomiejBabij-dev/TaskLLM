import { setTimeout as sleep } from 'node:timers/promises';
import type { AiRequest, AiResult, BillingMode, Provider, WorkflowNode } from '@/lib/contracts';
import { callAI, estimateMaxCost, ProviderError } from '@/lib/ai';
import { executePureNode, renderVariables, validateGraph } from '@/lib/workflow';
import { decryptSecret } from '@/lib/security/secrets';
import { getDb, query, transaction } from './db';
import { getPlan, ServiceError } from './services';

export class AccountBusyError extends Error {}
export const MAX_WORKER_ATTEMPTS = 5;
class CancelledError extends Error {}
function message(error:unknown):string {
 if(error instanceof ServiceError||error instanceof ProviderError||error instanceof CancelledError) return error.message;
 // Domain errors only have known, bounded validation messages, never provider bodies.
 if(error instanceof Error&&error.message.length<250&&!/sk-|Bearer|password|postgres|redis/i.test(error.message)) return error.message;
 return 'This execution could not finish. Review the node configuration and try again.';
}
interface Run {id:string;user_id:string;workflow_id:string;usage_month:string;status:string;started_at:string|null;max_duration_seconds:number;cancel_requested:boolean;worker_attempts:number;graph:unknown}
interface StoredStep {node_id:string;status:string;output:unknown;reserved_micros:number;billing_mode:BillingMode|null;attempts:number}
async function credentials(userId:string,provider:Provider,mode:BillingMode):Promise<string> {
 if(mode==='managed') {
  const key=process.env[provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY'];
  if(!key) throw new ServiceError('Managed AI is not configured for this provider.',503);
  return key;
 }
 const row=(await query('select encrypted_key from api_keys where user_id=$1 and provider=$2',[userId,provider]))[0];
 if(!row) throw new ServiceError(`Add your ${provider==='openai'?'OpenAI':'Anthropic'} API key in Settings.`,400);
 return decryptSecret(row.encrypted_key,`${userId}:${provider}`);
}
export async function reserveStep(run:Run,node:WorkflowNode,request:AiRequest,mode:BillingMode):Promise<number> {
 const reserve=estimateMaxCost(request);
 return transaction(async client=>{
  const profile=(await client.query('select * from profiles where id=$1 for update',[run.user_id])).rows[0];
  if(!profile||profile.suspended) throw new ServiceError('Account is unavailable.',403);
  const plan=await getPlan(run.user_id,client);
  const usage=(await client.query('select * from usage_limits where user_id=$1 and month=$2 for update',[run.user_id,run.usage_month])).rows[0];
  if(!usage) throw new ServiceError('Usage accounting is unavailable.',503);
  const total=Number(usage.managed_spent_micros)+Number(usage.byok_spent_micros)+Number(usage.managed_reserved_micros)+Number(usage.byok_reserved_micros);
  if(total+reserve>Number(profile.spending_cap_micros)) throw new ServiceError('Your monthly spending cap would be exceeded.',402);
  if(mode==='managed'&&Number(usage.managed_spent_micros)+Number(usage.managed_reserved_micros)+reserve>plan.monthly_ai_micros) throw new ServiceError('Managed AI budget is exhausted. Add your own key or change your plan.',402);
  const existing=(await client.query('select * from execution_steps where execution_id=$1 and node_id=$2 for update',[run.id,node.id])).rows[0];
  if(existing) throw new ServiceError('This AI step was already started; it will not be charged twice automatically.',409);
  await client.query(`update usage_limits set ${mode}_reserved_micros=${mode}_reserved_micros+$1 where user_id=$2 and month=$3`,[reserve,run.user_id,run.usage_month]);
  await client.query("insert into execution_steps(execution_id,user_id,node_id,status,provider,model,billing_mode,reserved_micros) values($1,$2,$3,'running',$4,$5,$6,$7)",[run.id,run.user_id,node.id,request.provider,request.model,mode,reserve]);
  return reserve;
 });
}
export async function settleAiStep(run:Run,node:WorkflowNode,request:AiRequest,mode:BillingMode,result:AiResult,status:'completed'|'failed'='completed',error?:string):Promise<void> {
 await transaction(async client=>{
  await client.query('select id from profiles where id=$1 for update',[run.user_id]);
  const step=(await client.query('select * from execution_steps where execution_id=$1 and node_id=$2 for update',[run.id,node.id])).rows[0];
  if(!step) throw new ServiceError('Execution checkpoint is missing.',503);
  if(step.status==='completed'||step.status==='failed') return;
  // Insert-first with a uniqueness constraint makes usage and checkpoint commits atomic.
  const inserted=await client.query('insert into ai_usage(user_id,execution_id,node_id,workflow_id,provider,model,billing_mode,input_tokens,output_tokens,cost_micros) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(execution_id,node_id) do nothing returning id',[run.user_id,run.id,node.id,run.workflow_id,request.provider,result.model,mode,result.inputTokens,result.outputTokens,result.costMicros]);
  if(!inserted.rowCount) return;
  await client.query(`update usage_limits set ${mode}_reserved_micros=${mode}_reserved_micros-$1,${mode}_spent_micros=${mode}_spent_micros+$2 where user_id=$3 and month=$4`,[step.reserved_micros,result.costMicros,run.user_id,run.usage_month]);
  const output=result.structuredData??result.text;
  await client.query('update execution_steps set status=$1,output=$2,error=$3,input_tokens=$4,output_tokens=$5,cost_micros=$6,reserved_micros=0,finished_at=now(),model=$7 where execution_id=$8 and node_id=$9',[status,JSON.stringify(output),error??null,result.inputTokens,result.outputTokens,result.costMicros,result.model,run.id,node.id]);
  await client.query('update executions set input_tokens=input_tokens+$1,output_tokens=output_tokens+$2,cost_micros=cost_micros+$3 where id=$4',[result.inputTokens,result.outputTokens,result.costMicros,run.id]);
  if(result.costMicros>Number(step.reserved_micros)) {
   await client.query('update profiles set suspended=true where id=$1',[run.user_id]);
   await client.query("insert into audit_events(user_id,action,resource_id) values($1,'cost.reservation_exceeded',$2)",[run.user_id,run.id]);
  }
 });
}
async function rejectAiStep(run:Run,node:WorkflowNode,mode:BillingMode,error:unknown):Promise<void> {
 // Only explicit client rejection is known not to have generated chargeable output.
 const definitive=error instanceof ProviderError&&[400,401,403,404,413,422,429].includes(error.status)&&!error.usage;
 await transaction(async client=>{
  await client.query('select id from profiles where id=$1 for update',[run.user_id]);
  const step=(await client.query('select * from execution_steps where execution_id=$1 and node_id=$2 for update',[run.id,node.id])).rows[0];
  if(!step||step.status==='completed'||step.status==='failed') return;
  if(definitive&&Number(step.reserved_micros)>0) await client.query(`update usage_limits set ${mode}_reserved_micros=${mode}_reserved_micros-$1 where user_id=$2 and month=$3`,[step.reserved_micros,run.user_id,run.usage_month]);
  await client.query('update execution_steps set status=$1,error=$2,finished_at=now(),reserved_micros=$3 where execution_id=$4 and node_id=$5',[definitive?'failed':'uncertain',message(error),definitive?0:step.reserved_micros,run.id,node.id]);
  if(!definitive) await client.query("insert into audit_events(user_id,action,resource_id) values($1,'ai.reconciliation_required',$2)",[run.user_id,`${run.id}:${node.id}`]);
 });
}
function aiRequest(node:WorkflowNode,outputs:Record<string,unknown>):AiRequest {
 const c=node.config;
 return {provider:c.provider as Provider,model:String(c.model),prompt:renderVariables(String(c.prompt),outputs),systemInstruction:String(c.systemInstruction??''),input:c.input?renderVariables(String(c.input),outputs):undefined,maxOutputTokens:Number(c.maxOutputTokens),...(c.temperature!==undefined?{temperature:Number(c.temperature)}:{}),structuredOutput:c.structuredOutput===true};
}
async function runAi(run:Run,node:WorkflowNode,outputs:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
 const request=aiRequest(node,outputs); const mode=node.config.billingMode as BillingMode;
 const key=await credentials(run.user_id,request.provider,mode);
 await reserveStep(run,node,request,mode);
 for(let attempt=1;attempt<=3;attempt++) {
  try {
   const result=await callAI(request,key,signal);
   await settleAiStep(run,node,request,mode,result);
   return result.structuredData??result.text;
  } catch(error) {
   if(error instanceof ProviderError&&error.usage) { await settleAiStep(run,node,request,mode,error.usage,'failed',message(error)); throw error; }
   if(error instanceof ProviderError&&error.status===429&&error.retriable&&attempt<3&&!signal.aborted) {
    await query('update execution_steps set attempts=attempts+1 where execution_id=$1 and node_id=$2',[run.id,node.id]);
    try { await sleep(1000*2**(attempt-1)+Math.random()*500,undefined,{signal}); }
    catch { await rejectAiStep(run,node,mode,error); throw new CancelledError('Execution was cancelled.'); }
    continue;
   }
   await rejectAiStep(run,node,mode,error); throw error;
  }
 }
 throw new ServiceError('AI retry limit reached.',503);
}
async function sendEmail(run:Run,node:WorkflowNode,outputs:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
 const key=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM;
 if(!key||!from) throw new ServiceError('Email delivery is not configured.',503);
 const subject=renderVariables(String(node.config.subject),outputs);
 const text=renderVariables(String(node.config.body),outputs);
 const to=String(node.config.to);
 if(subject.length>200||text.length>100000) throw new ServiceError('Email content is too large.');
 await query("insert into execution_steps(execution_id,user_id,node_id,status) values($1,$2,$3,'running')",[run.id,run.user_id,node.id]);
 for(let attempt=1;attempt<=3;attempt++) {
  try {
   const response=await fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','Idempotency-Key':`taskllm-${run.id}-${node.id}`},body:JSON.stringify({from,to:[to],subject,text}),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
   if(!response.ok) {
    if((response.status===429||response.status>=500)&&attempt<3) {await query('update execution_steps set attempts=attempts+1 where execution_id=$1 and node_id=$2',[run.id,node.id]); await sleep(1000*2**attempt,undefined,{signal});continue;}
    throw new ServiceError(response.status===401?'Email provider credentials are invalid.':'Email delivery was rejected.',502);
   }
   const receipt=await response.json() as {id?:string};
   if(!receipt.id) throw new ServiceError('Email delivery status is uncertain.',502);
   const output={messageId:receipt.id,accepted:true};
   await query("update execution_steps set status='completed',output=$1,finished_at=now() where execution_id=$2 and node_id=$3",[JSON.stringify(output),run.id,node.id]);
   return output;
  } catch(error) {
   // No replay after an ambiguous network failure, even beyond Resend's dedupe window.
   await query("update execution_steps set status='uncertain',error=$1,finished_at=now() where execution_id=$2 and node_id=$3",[message(error),run.id,node.id]);
   throw error;
  }
 }
 throw new ServiceError('Email retry limit reached.',503);
}
async function finish(run:Run,status:'completed'|'failed'|'cancelled',result:unknown,error:string|null):Promise<void> {
 await transaction(async client=>{
  await client.query('update executions set status=$1,result=$2,error=$3,finished_at=now(),heartbeat_at=now() where id=$4 and status in (\'queued\',\'running\')',[status,result===undefined?null:JSON.stringify(result),error,run.id]);
  const profile=(await client.query('select notify_completed,notify_failed from profiles where id=$1',[run.user_id])).rows[0];
  if((status==='completed'&&profile?.notify_completed)||(status==='failed'&&profile?.notify_failed)) await client.query('insert into notifications(user_id,dedupe_key,title,body) values($1,$2,$3,$4) on conflict(user_id,dedupe_key) do nothing',[run.user_id,`execution:${run.id}:${status}`,status==='completed'?'Workflow completed':'Workflow failed',error??'Your results are ready in execution history.']);
  await client.query('insert into execution_logs(user_id,execution_id,level,message) values($1,$2,$3,$4)',[run.user_id,run.id,status==='failed'?'error':'info',error??`Execution ${status}.`]);
 });
}
export async function processExecution(executionId:string):Promise<void> {
 const lock=await getDb().connect();
 let acquired=false;
 let run:Run|undefined; let heartbeat:ReturnType<typeof setInterval>|undefined;
 const abort=new AbortController();
 let stoppedReason:'cancelled'|'timeout'|'suspended'|'unavailable'|undefined;
 try {
  acquired=(await lock.query('select pg_try_advisory_lock(hashtext($1)) locked',[`taskllm:execution:${executionId}`])).rows[0].locked;
  if(!acquired) throw new AccountBusyError('Execution is already being processed.');
  run=await transaction(async client=>{
   const found=(await client.query('select e.*,v.graph from executions e join workflow_versions v on v.id=e.version_id where e.id=$1',[executionId])).rows[0] as Run|undefined;
   if(!found||['completed','failed','cancelled'].includes(found.status)) return undefined;
   const profile=(await client.query('select suspended from profiles where id=$1 for update',[found.user_id])).rows[0];
   if(!profile||profile.suspended) throw new ServiceError('Account is suspended.',403);
   const plan=await getPlan(found.user_id,client);
   const running=Number((await client.query("select count(*) n from executions where user_id=$1 and id<>$2 and status='running' and heartbeat_at>now()-interval '30 seconds'",[found.user_id,found.id])).rows[0].n);
   if(running>=plan.concurrency) throw new AccountBusyError('Account concurrency limit reached.');
   if(found.worker_attempts>=MAX_WORKER_ATTEMPTS) throw new ServiceError('Worker recovery limit reached. Check execution history before starting another run.',409);
   await client.query("update executions set status='running',started_at=coalesce(started_at,now()),heartbeat_at=now(),worker_attempts=worker_attempts+1 where id=$1",[executionId]);
   return found;
  });
  if(!run)return;
  const deadline=new Date(run.started_at??Date.now()).getTime()+run.max_duration_seconds*1000;
  const check=async()=>{
   const state=(await query('select e.cancel_requested,p.suspended from executions e join profiles p on p.id=e.user_id where e.id=$1',[executionId]))[0];
   if(!state||state.cancel_requested||state.suspended||Date.now()>=deadline) {stoppedReason=state?.cancel_requested?'cancelled':state?.suspended?'suspended':Date.now()>=deadline?'timeout':'unavailable';abort.abort();}
   else await query('update executions set heartbeat_at=now() where id=$1',[executionId]);
  };
  const stoppedError=()=>new CancelledError(stoppedReason==='cancelled'?'Execution was cancelled.':stoppedReason==='suspended'?'Account is suspended.':stoppedReason==='timeout'?'Execution duration limit reached.':'Execution stopped because its status could not be verified.');
  await check(); heartbeat=setInterval(()=>{check().catch(()=>{stoppedReason='unavailable';abort.abort();});},5000);
  const timeout=setTimeout(()=>{stoppedReason='timeout';abort.abort();},Math.max(0,deadline-Date.now()));
  try {
   const nodes=validateGraph(run.graph); const outputs:Record<string,unknown>=Object.create(null);
   const checkpoints=await query<StoredStep>('select node_id,status,output,reserved_micros,billing_mode,attempts from execution_steps where execution_id=$1',[executionId]);
   for(const node of nodes) {
    await check();
    if(abort.signal.aborted) throw stoppedError();
    const previous=checkpoints.find(s=>s.node_id===node.id);
    if(previous?.status==='completed') {outputs[node.id]=previous.output;continue;}
    if(previous&&(node.type==='ai'||node.type==='email')) {
     await query("update execution_steps set status='uncertain',error='Worker interrupted during an external request. Automatic replay is disabled; check provider usage.',finished_at=now() where execution_id=$1 and node_id=$2",[run.id,node.id]);
     throw new ServiceError('An external request was interrupted. Its billing or delivery status requires reconciliation before retrying.',409);
    }
    let output:unknown;
    if(node.type==='ai') output=await runAi(run,node,outputs,abort.signal);
    else if(node.type==='email') output=await sendEmail(run,node,outputs,abort.signal);
    else {
     await query("insert into execution_steps(execution_id,user_id,node_id,status) values($1,$2,$3,'running') on conflict(execution_id,node_id) do update set status='running',attempts=execution_steps.attempts+1",[run.id,run.user_id,node.id]);
     try {output=executePureNode(node,outputs);}
     catch(error) {await query("update execution_steps set status='failed',error=$1,finished_at=now() where execution_id=$2 and node_id=$3",[message(error),run.id,node.id]);throw error;}
     await query("update execution_steps set status='completed',output=$1,finished_at=now() where execution_id=$2 and node_id=$3",[JSON.stringify(output),run.id,node.id]);
    }
    outputs[node.id]=output;
   }
   await check();
   if(abort.signal.aborted) throw stoppedError();
   await finish(run,'completed',outputs[nodes[nodes.length-1].id],null);
  } finally {clearTimeout(timeout);}
 } catch(error) {
  if(error instanceof AccountBusyError) throw error;
  if(run) {
   const cancelled=stoppedReason==='cancelled'||(error instanceof CancelledError&&error.message==='Execution was cancelled.');
   const finalMessage=cancelled?'Execution was cancelled.':stoppedReason==='timeout'?'Execution duration limit reached.':stoppedReason==='suspended'?'Account is suspended.':message(error);
   await finish(run,cancelled?'cancelled':'failed',undefined,finalMessage);
  } else {
   // Claim failures (e.g. suspended account) must terminate the queued execution.
   await query("update executions set status='failed',error=$1,finished_at=now() where id=$2 and status in ('queued','running')",[message(error),executionId]);
  }
 } finally {
  if(heartbeat)clearInterval(heartbeat);
  try {if(acquired)await lock.query('select pg_advisory_unlock(hashtext($1))',[`taskllm:execution:${executionId}`]);lock.release();}
  catch {lock.release(true);}
 }
}
