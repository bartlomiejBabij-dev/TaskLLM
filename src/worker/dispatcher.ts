import { query,transaction } from '../server/db';
import { enqueueWithClient,ServiceError } from '../server/services';
import { nextRun } from '../lib/workflow';

export interface DispatchQueue {
 add(name:string,data:{executionId:string},options:{jobId:string}):Promise<unknown>;
 getJob(id:string):Promise<{isFailed():Promise<boolean>}|undefined>;
}

export async function dispatchOutbox(queue: DispatchQueue) {
 await transaction(async client=>{
  const pending=(await client.query('select o.execution_id from job_outbox o join executions e on e.id=o.execution_id where o.dispatched_at is null and e.status=\'queued\' order by o.created_at limit 50 for update of o skip locked')).rows;
  for(const row of pending) {
   await queue.add('execute',{executionId:row.execution_id},{jobId:row.execution_id});
   await client.query('update job_outbox set dispatched_at=now(),attempts=attempts+1 where execution_id=$1',[row.execution_id]);
  }
 });
 // Recover queue data lost during a Redis restart. PostgreSQL owns job intent.
 const stranded=await query("select id from executions where status='queued' or (status='running' and heartbeat_at<now()-interval '90 seconds') order by created_at limit 100");
 for(const row of stranded) {
  const job=await queue.getJob(row.id);
  if(!job) await queue.add('execute',{executionId:row.id},{jobId:row.id});
  else if(await job.isFailed()) {
   // Never reset BullMQ's exhausted attempt count in the recovery scan.
   // Redis loss is bounded independently by executions.worker_attempts.
   await transaction(async client=>{
    const result=await client.query("update executions set status='failed',error='Worker retry limit reached. Check service health before starting another run.',finished_at=now() where id=$1 and status in ('queued','running') returning user_id",[row.id]);
    if(result.rows[0])await client.query("insert into execution_logs(user_id,execution_id,level,message) values($1,$2,'error','Worker retry limit reached.')",[result.rows[0].user_id,row.id]);
   });
  }
 }
}

export async function dispatchSchedules() {
 const due=await query("select s.id,s.user_id from schedules s join workflows w on w.id=s.workflow_id where s.enabled and s.next_run_at<=now() and w.status='active' order by s.next_run_at limit 50");
 for(const item of due) {
  try {
   await transaction(async client=>{
    // Same lock ordering as interactive account mutations.
    await client.query('select id from profiles where id=$1 for update',[item.user_id]);
    const schedule=(await client.query("select s.* from schedules s join workflows w on w.id=s.workflow_id where s.id=$1 and s.enabled and s.next_run_at<=now() and w.status='active' for update of s skip locked",[item.id])).rows[0];
    if(!schedule)return;
    if(schedule.ends_at&&new Date(schedule.ends_at)<new Date()) {await client.query('update schedules set enabled=false where id=$1',[item.id]);return;}
    const slot=new Date(schedule.next_run_at).toISOString();
    await enqueueWithClient(client,schedule.user_id,schedule.workflow_id,`schedule:${schedule.id}:${slot}`);
    // Deliberately coalesce downtime into one run instead of a burst of catch-up jobs.
    const next=schedule.cron?nextRun(schedule.cron,schedule.timezone,new Date()):null;
    const enabled=!!next&&(!schedule.ends_at||next<=new Date(schedule.ends_at));
    await client.query('update schedules set next_run_at=$1,enabled=$2 where id=$3',[enabled?next:null,enabled,item.id]);
   });
  } catch(error) {
   if(error instanceof ServiceError&&[400,402,403,404,429].includes(error.status)) {
    await transaction(async client=>{
     await client.query('update schedules set enabled=false where id=$1',[item.id]);
     await client.query('insert into notifications(user_id,dedupe_key,title,body) values($1,$2,$3,$4) on conflict(user_id,dedupe_key) do nothing',[item.user_id,`schedule-paused:${item.id}:${new Date().toISOString().slice(0,10)}`,'Schedule paused',error.message]);
    });
   } else console.error('Schedule dispatcher could not process a run; it remains durable in PostgreSQL.');
  }
 }
}
