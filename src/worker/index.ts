import { Queue, Worker, DelayedError } from 'bullmq';
import IORedis from 'ioredis';
import { getDb } from '../server/db';
import { AccountBusyError, processExecution } from '../server/execution';
import { dispatchOutbox,dispatchSchedules } from './dispatcher';

if(!process.env.REDIS_URL) throw new Error('Set REDIS_URL before starting the worker.');
if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before starting the worker.');
const connection=new IORedis(process.env.REDIS_URL,{maxRetriesPerRequest:null,enableReadyCheck:true});
const queueConnection=new IORedis(process.env.REDIS_URL,{maxRetriesPerRequest:1,commandTimeout:5000,enableReadyCheck:true});
const queue=new Queue('taskllm-executions',{connection:queueConnection,defaultJobOptions:{attempts:5,backoff:{type:'exponential',delay:2000},removeOnComplete:{age:86400,count:1000},removeOnFail:{age:604800,count:1000}}});
const worker=new Worker('taskllm-executions',async(job,token)=>{
 try { await processExecution(job.data.executionId as string); }
 catch(error) {
  if(error instanceof AccountBusyError) {await job.moveToDelayed(Date.now()+5000,token);throw new DelayedError();}
  throw error;
 }
},{connection,concurrency:5,lockDuration:60000,maxStalledCount:2});

let ticking=false;
async function tick() {
 if(ticking)return;ticking=true;
 try {await dispatchSchedules();await dispatchOutbox(queue);}
 catch {console.error('Dispatcher unavailable. Pending runs remain in PostgreSQL and will be retried.');}
 finally {ticking=false;}
}
worker.on('error',()=>console.error('Worker connection error. Check database and Redis connectivity.'));
worker.on('failed',()=>console.error('Job attempt failed; inspect execution history for its sanitized status.'));
connection.on('error',()=>console.error('Redis connection unavailable.'));
queueConnection.on('error',()=>console.error('Redis dispatch connection unavailable.'));
const timer=setInterval(()=>void tick(),10000);
void tick();
console.log('TaskLLM worker started. Scheduler and outbox scan every 10 seconds.');
async function shutdown() {clearInterval(timer);await worker.close();await queue.close();await connection.quit();await queueConnection.quit();await getDb().end();}
process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});
