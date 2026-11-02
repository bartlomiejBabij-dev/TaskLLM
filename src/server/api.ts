import { z } from 'zod';
import { NextResponse } from 'next/server';
import { authenticatedUser,authAdmin,authClient } from './auth';
import { hasAppConfig } from './config';
import { checkOrigin,failure,HttpError,ok,rateLimit,readBody } from './http';
import * as service from './services';
import { query,transaction } from './db';
import { checkoutSchema,createCheckout,createPortal } from './billing';
import { decryptSecret,encryptSecret } from '@/lib/security/secrets';
import { testConnection } from '@/lib/ai/adapters';
import { templates } from '@/lib/workflow/templates';
import type { WorkflowGraph } from '@/lib/contracts';

const workflowInput=z.object({name:z.string().trim().min(1).max(100),description:z.string().max(1000).default(''),graph:z.object({nodes:z.array(z.unknown()).max(100),edges:z.array(z.unknown()).max(500)}),expected_version_id:z.uuid().optional()});
const scheduleInput=z.object({id:z.uuid().optional(),workflow_id:z.uuid(),cron:z.string().max(100).nullable().optional(),timezone:z.string().max(100),run_at:z.iso.datetime({offset:true}).optional(),ends_at:z.iso.datetime({offset:true}).nullable().optional()});

export async function handleApi(request:Request,path:string[]) {
  try {
    checkOrigin(request);
    if(!hasAppConfig())throw new HttpError(503,'Connect Supabase and PostgreSQL to use your workspace.');
    const user=await authenticatedUser();if(!user)throw new HttpError(401,'Sign in to continue.');
    const uid=user.id;await service.getProfile(uid);
    await rateLimit(`api:${uid}`,180,60);
    const [resource,id,action]=path;const method=request.method;const url=new URL(request.url);
    if(path.length>3)throw new HttpError(404,'Not found.');
    if(id && !['checkout','portal'].includes(id))z.uuid().parse(id);
    if(resource==='dashboard' && method==='GET')return ok(await service.getDashboard(uid));
    if(resource==='plans' && method==='GET')return ok(await query('select * from plans where id <> $1 order by price_cents',['trial']));
    if(resource==='templates' && method==='GET')return ok(templates);
    if(resource==='workflows') {
      if(method==='GET')return ok(id?await service.getWorkflow(uid,id):await service.listWorkflows(uid));
      if(method==='POST'&&!id) {const input=workflowInput.parse(await readBody(request));return ok(await service.saveWorkflow(uid,{...input,graph:input.graph as WorkflowGraph}),201);}
      if(id && method==='PATCH') {
        const body=await readBody(request);
        if(body&&typeof body==='object'&&'status' in body) {const input=z.object({status:z.enum(['draft','active','paused'])}).strict().parse(body);return ok(await service.setWorkflowStatus(uid,id,input.status));}
        const input=workflowInput.parse(body);return ok(await service.saveWorkflow(uid,{...input,id,graph:input.graph as WorkflowGraph}));
      }
      if(id && method==='DELETE') {await service.deleteWorkflow(uid,id);return ok({deleted:true});}
      if(id && method==='POST' && action==='duplicate')return ok(await service.duplicateWorkflow(uid,id),201);
      if(id && method==='POST' && action==='run') {
        await rateLimit(`runs:${uid}`,15,60);
        const key=z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers.get('idempotency-key'));
        return ok(await service.enqueueExecution(uid,id,key),202);
      }
    }
    if(resource==='executions') {
      if(method==='GET' && !id) {
        const page=z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page')||1);
        const status=z.enum(['queued','running','completed','failed','cancelled']).optional().parse(url.searchParams.get('status')||undefined);
        return ok(await service.listExecutions(uid,{page,status,search:(url.searchParams.get('search')||'').slice(0,100)}));
      }
      if(method==='GET' && id) {
        const data=await service.getExecution(uid,id);
        if(action==='download')return new NextResponse(JSON.stringify(data,null,2),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="taskllm-${id}.json"`,'Cache-Control':'private, no-store'}});
        return ok(data);
      }
      if(method==='POST'&&id&&action==='cancel'){await service.cancelExecution(uid,id);return ok({cancelled:true});}
    }
    if(resource==='usage'&&method==='GET')return ok(await service.getUsage(uid));
    if(resource==='schedules') {
      if(method==='GET')return ok(await service.listSchedules(uid));
      if(method==='POST')return ok(await service.saveSchedule(uid,scheduleInput.parse(await readBody(request,4096))),201);
      if(method==='PATCH'&&id){const body=z.object({enabled:z.boolean()}).parse(await readBody(request,1024));await service.toggleSchedule(uid,id,body.enabled);return ok({updated:true});}
      if(method==='DELETE'&&id){await service.deleteSchedule(uid,id);return ok({deleted:true});}
    }
    if(resource==='profile') {
      if(method==='GET')return ok(await service.getProfile(uid));
      if(method==='PATCH')return ok(await service.updateProfile(uid,await readBody(request,4096)));
      if(method==='DELETE') {
        z.object({confirmation:z.literal('DELETE')}).parse(await readBody(request,1024));
        const client=await authClient();const signed=await client.auth.getUser();
        if(!signed.data.user)throw new HttpError(401,'Sign in again.');
        // Freeze new jobs before checking/erasing the auth identity; rollback on failure.
        await transaction(async db=>{
          await db.query('select id from profiles where id=$1 for update',[uid]);
          const active=await db.query(`select 1 from subscriptions where user_id=$1 and status not in ('inactive','canceled','incomplete_expired')`,[uid]);
          if(active.rowCount)throw new HttpError(409,'Cancel your subscription and wait for it to end before deleting your account.');
          const runs=await db.query(`select 1 from executions where user_id=$1 and status in ('queued','running')`,[uid]);
          if(runs.rowCount)throw new HttpError(409,'Cancel or finish all executions before deleting your account.');
          await db.query('update profiles set suspended=true where id=$1',[uid]);
          await db.query('update schedules set enabled=false where user_id=$1',[uid]);
        });
        try {
          const {error}=await authAdmin().auth.admin.deleteUser(uid);if(error)throw new Error('Deletion failed');
          await client.auth.signOut();return ok({deleted:true,redirect:'/'});
        } catch(error) {await query('update profiles set suspended=false where id=$1',[uid]);throw error;}
      }
    }
    if(resource==='keys') {
      if(method==='GET')return ok(await service.listApiKeys(uid));
      if(method==='POST'&&!id) {
        await rateLimit(`keys:${uid}`,5,60);
        const input=z.object({provider:z.enum(['openai','anthropic']),key:z.string().trim().min(20).max(512)}).parse(await readBody(request,2048));
        await service.storeApiKey(uid,{provider:input.provider,encrypted_key:encryptSecret(input.key,`${uid}:${input.provider}`),last_four:input.key.slice(-4)});
        return ok(await service.listApiKeys(uid),201);
      }
      if(method==='DELETE'&&id) {await service.removeApiKey(uid,id);return ok({deleted:true});}
      if(method==='POST'&&id&&action==='test') {
        await rateLimit(`key-test:${uid}`,5,60);
        const keys=await query<{provider:'openai'|'anthropic';encrypted_key:string}>('select provider,encrypted_key from api_keys where id=$1 and user_id=$2',[id,uid]);
        if(!keys[0])throw new HttpError(404,'Key not found.');
        try {await testConnection(keys[0].provider,decryptSecret(keys[0].encrypted_key,`${uid}:${keys[0].provider}`));}
        catch {await query(`update api_keys set status='invalid' where id=$1 and user_id=$2`,[id,uid]);throw new HttpError(400,'Connection could not be verified. Check the key and provider availability.');}
        await query(`update api_keys set status='connected' where id=$1 and user_id=$2`,[id,uid]);return ok({status:'connected'});
      }
    }
    if(resource==='billing') {
      if(method==='GET')return ok({plan:await service.getPlan(uid),subscription:await service.getSubscription(uid)});
      if(method==='POST'&&id==='checkout'){await rateLimit(`checkout:${uid}`,5,60);const {planId}=checkoutSchema.parse(await readBody(request,1024));return ok(await createCheckout(uid,user.email||'',planId));}
      if(method==='POST'&&id==='portal')return ok({url:(await createPortal(uid)).url});
    }
    if(resource==='notifications') {
      if(method==='GET')return ok(await service.listNotifications(uid));
      if(method==='PATCH'&&id){await service.markNotification(uid,id);return ok({read:true});}
    }
    if(resource==='admin') {
      const profile=await service.getProfile(uid);if(!profile.is_admin)throw new HttpError(403,'Administrator access required.');
      if(method==='GET')return ok(await service.getAdminOverview(uid));
      if(method==='PATCH'&&id) {
        const body=z.object({suspended:z.boolean()}).parse(await readBody(request,1024));
        if(id===uid)throw new HttpError(400,'You cannot suspend your own administrator account.');
        await transaction(async db=>{await db.query('update profiles set suspended=$2 where id=$1',[id,body.suspended]);await db.query(`insert into audit_events(user_id,action,resource_id) values($1,$2,$3)`,[uid,body.suspended?'account.suspended':'account.resumed',id]);});return ok({updated:true});
      }
    }
    throw new HttpError(404,'Not found.');
  } catch(error) {return failure(error);}
}
