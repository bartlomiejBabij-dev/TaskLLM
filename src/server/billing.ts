import Stripe from 'stripe';
import { z } from 'zod';
import { appOrigin, requiredEnv } from './config';
import { query, transaction } from './db';
import { HttpError } from './http';

let client: Stripe | undefined;
export function stripe() { return client ??= new Stripe(requiredEnv('STRIPE_SECRET_KEY'), {maxNetworkRetries:2,timeout:15000}); }
export const paidPlans=['starter','pro','byok'] as const;
export function priceFor(planId:string):string {
  if(!paidPlans.includes(planId as typeof paidPlans[number]))throw new HttpError(400,'Choose an available plan.');
  return requiredEnv(`STRIPE_PRICE_${planId.toUpperCase()}`);
}
export function planForPrice(priceId:string):string | null {
  return paidPlans.find(id=>process.env[`STRIPE_PRICE_${id.toUpperCase()}`]===priceId)||null;
}
async function ensureCustomer(userId:string,email:string) {
  return transaction(async db=>{
    const profile=await db.query<{suspended:boolean}>('select suspended from profiles where id=$1 for update',[userId]);
    if(!profile.rows[0]||profile.rows[0].suspended)throw new HttpError(403,'Account is unavailable.');
    const result=await db.query<{stripe_customer_id:string|null}>('select stripe_customer_id from subscriptions where user_id=$1',[userId]);
    if(result.rows[0]?.stripe_customer_id)return result.rows[0].stripe_customer_id;
    const customer=await stripe().customers.create({email,metadata:{taskllm_user_id:userId}},{idempotencyKey:`taskllm-customer-${userId}`});
    await db.query(`insert into subscriptions(user_id,stripe_customer_id) values($1,$2) on conflict(user_id) do update set stripe_customer_id=excluded.stripe_customer_id`,[userId,customer.id]);
    return customer.id;
  });
}
export async function createCheckout(userId:string,email:string,planId:string) {
  const price=priceFor(planId);
  const customer=await ensureCustomer(userId,email);
  return transaction(async db=>{
    // Serialize concurrent plan selections, including abandoned but still payable sessions.
    const profile=await db.query<{suspended:boolean}>('select suspended from profiles where id=$1 for update',[userId]);
    if(!profile.rows[0]||profile.rows[0].suspended)throw new HttpError(403,'Account is unavailable.');
    const existing=await stripe().subscriptions.list({customer,status:'all',limit:100});
    if(existing.data.some(s=>!['canceled','incomplete_expired'].includes(s.status)))throw new HttpError(409,'Manage your existing subscription in the billing portal.');
    const pending=await stripe().checkout.sessions.list({customer,status:'open',limit:100});
    const open=pending.data.find(session=>session.mode==='subscription');
    if(open) {
      if(open.metadata?.taskllm_plan_id===planId&&open.url)return {url:open.url};
      throw new HttpError(409,'Another plan checkout is already open. Complete it or wait for it to expire before choosing a different plan.');
    }
    const session=await stripe().checkout.sessions.create({
      mode:'subscription',customer,line_items:[{price,quantity:1}],
      success_url:`${appOrigin()}/settings/billing?checkout=returned`,cancel_url:`${appOrigin()}/settings/billing`,
      client_reference_id:userId,metadata:{taskllm_plan_id:planId},subscription_data:{metadata:{taskllm_user_id:userId}},
      expires_at:Math.floor(Date.now()/1000)+1860,
    },{idempotencyKey:`taskllm-checkout-${userId}-${planId}-${Math.floor(Date.now()/1800000)}`});
    return {url:session.url};
  });
}
export async function createPortal(userId:string) {
  const rows=await query<{stripe_customer_id:string}>('select stripe_customer_id from subscriptions where user_id=$1',[userId]);
  if(!rows[0]?.stripe_customer_id)throw new HttpError(400,'No billing customer exists yet.');
  return stripe().billingPortal.sessions.create({customer:rows[0].stripe_customer_id,return_url:`${appOrigin()}/settings/billing`});
}

export async function processBillingEvent(event:Stripe.Event) {
  const relevant=event.type.startsWith('customer.subscription.') || event.type==='invoice.payment_failed' || event.type==='invoice.paid';
  if(!relevant)return;
  const object=event.data.object as unknown as {id:string;customer:string|{id:string}|null};
  const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
  if(!customer)return;
  await transaction(async db=>{
    // Serialize all events for the customer, including events delivered out of order.
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[`stripe:${customer}`]);
    if((await db.query('select id from payment_events where id=$1',[event.id])).rowCount)return;
    const rows=await db.query<{user_id:string;stripe_subscription_id:string|null}>('select user_id,stripe_subscription_id from subscriptions where stripe_customer_id=$1 for update',[customer]);
    if(rows.rows[0]) {
      const account=rows.rows[0];
      // Read current provider state instead of trusting event arrival order.
      const list=await stripe().subscriptions.list({customer,status:'all',limit:100});
      const current=list.data.filter(s=>!['canceled','incomplete_expired'].includes(s.status)).sort((a,b)=>b.created-a.created)[0]
        ||list.data.find(s=>s.id===account.stripe_subscription_id)||list.data.sort((a,b)=>b.created-a.created)[0];
      if(current) {
        const item=current.items.data[0]; const plan=planForPrice(item?.price.id || '');
        const valid=current.items.data.length===1 && item.quantity===1 && plan!==null;
        const periodEnd=item?.current_period_end;
        await db.query(`update subscriptions set stripe_subscription_id=$2,plan_id=$3,status=$4,current_period_end=$5,cancel_at_period_end=$6,last_event_created=greatest(last_event_created,$7),updated_at=now() where user_id=$1`,
          [account.user_id,current.id,valid?plan:'trial',valid?current.status:'inactive',periodEnd?new Date(periodEnd*1000):null,current.cancel_at_period_end,event.created]);
      } else {
        await db.query(`update subscriptions set plan_id='trial',status='inactive',current_period_end=null,updated_at=now() where user_id=$1`,[account.user_id]);
      }
      if(event.type==='invoice.payment_failed') {
        await db.query(`insert into notifications(user_id,dedupe_key,title,body) values($1,$2,'Payment failed','Update your payment method in Billing to restore your plan.') on conflict(user_id,dedupe_key) do nothing`,[account.user_id,`payment:${object.id}`]);
      }
      await db.query(`insert into audit_events(user_id,action,resource_id) values($1,'billing.synced',$2)`,[account.user_id,event.id]);
    }
    await db.query('insert into payment_events(id,type,created) values($1,$2,$3)',[event.id,event.type,event.created]);
  });
}
export const checkoutSchema=z.object({planId:z.enum(paidPlans)});
