import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';

const state=vi.hoisted(()=>({db:null as unknown as PGlite}));
vi.mock('../src/server/db',()=>({
  query:async(sql:string,params:unknown[]=[]) => (await state.db.query(sql,params)).rows,
  transaction:async(fn:(client:unknown)=>Promise<unknown>)=>state.db.transaction(async client=>fn({query:async(sql:string,params:unknown[]=[])=>{const r=await client.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0};}})),
}));
import { checkoutSchema,createCheckout,createPortal,planForPrice,priceFor,processBillingEvent,stripe } from '../src/server/billing';
import { POST as webhook } from '../src/app/api/webhooks/stripe/route';

const alice='11111111-1111-4111-8111-111111111111';
const secret='whsec_local_test_only_not_a_live_credential';
let subscriptions:ReturnType<typeof vi.spyOn>;
let checkoutList:ReturnType<typeof vi.spyOn>;
let checkoutCreate:ReturnType<typeof vi.spyOn>;
let customersCreate:ReturnType<typeof vi.spyOn>;
let portalCreate:ReturnType<typeof vi.spyOn>;
function subscription(overrides:Partial<Stripe.Subscription>={}):Stripe.Subscription {
  return {id:'sub_current',object:'subscription',customer:'cus_alice',status:'active',created:100,cancel_at_period_end:false,items:{data:[{quantity:1,price:{id:'price_pro'},current_period_end:Math.floor(Date.now()/1000)+86400}]},...overrides} as Stripe.Subscription;
}
function event(id:string,type='customer.subscription.updated',created=200):Stripe.Event {
  return {id,object:'event',type,created,data:{object:{id:type.startsWith('invoice.')?'in_one':'sub_current',customer:'cus_alice',status:'active'}},livemode:false} as Stripe.Event;
}
async function storedSubscription(){return (await state.db.query<{plan_id:string;status:string;stripe_subscription_id:string}>('select * from subscriptions where user_id=$1',[alice])).rows[0];}

beforeAll(async()=>{
  vi.stubEnv('APP_URL','https://taskllm.example');
  vi.stubEnv('STRIPE_SECRET_KEY','sk_test_local_fixture_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET',secret);
  vi.stubEnv('STRIPE_PRICE_STARTER','price_starter');vi.stubEnv('STRIPE_PRICE_PRO','price_pro');vi.stubEnv('STRIPE_PRICE_BYOK','price_byok');
  state.db=new PGlite();
  await state.db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to authenticated,anon;`);
  await state.db.exec(await readFile('supabase/migrations/0001_initial.sql','utf8'));
  subscriptions=vi.spyOn(stripe().subscriptions,'list');
  checkoutList=vi.spyOn(stripe().checkout.sessions,'list');
  checkoutCreate=vi.spyOn(stripe().checkout.sessions,'create');
  customersCreate=vi.spyOn(stripe().customers,'create');
  portalCreate=vi.spyOn(stripe().billingPortal.sessions,'create');
});
beforeEach(async()=>{
  vi.clearAllMocks();
  await state.db.exec('truncate auth.users cascade; truncate payment_events;');
  await state.db.query('insert into auth.users(id,email) values($1,$2)',[alice,'alice@example.test']);
  await state.db.query("insert into subscriptions(user_id,stripe_customer_id) values($1,'cus_alice')",[alice]);
  subscriptions.mockResolvedValue({data:[]} as never);
  checkoutList.mockResolvedValue({data:[]} as never);
  checkoutCreate.mockResolvedValue({id:'cs_fixture',url:'https://checkout.stripe.com/local-fixture'} as never);
  customersCreate.mockResolvedValue({id:'cus_alice'} as never);
  portalCreate.mockResolvedValue({url:'https://billing.stripe.com/local-fixture'} as never);
});
afterAll(async()=>{await state.db.close();vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('Stripe billing with real PostgreSQL semantics and mocked Stripe API',()=>{
  it('only accepts known plans and resolves server-side prices',()=>{
    expect(priceFor('pro')).toBe('price_pro');expect(planForPrice('price_byok')).toBe('byok');expect(planForPrice('price_untrusted')).toBeNull();
    expect(()=>priceFor('trial')).toThrow();expect(()=>priceFor('price_untrusted')).toThrow();
    expect(checkoutSchema.safeParse({planId:'enterprise',price:'price_pro'}).success).toBe(false);
  });
  it('creates Checkout without granting a plan and uses canonical redirect URLs',async()=>{
    expect(await createCheckout(alice,'alice@example.test','pro')).toEqual({url:'https://checkout.stripe.com/local-fixture'});
    expect(checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({customer:'cus_alice',mode:'subscription',line_items:[{price:'price_pro',quantity:1}],success_url:'https://taskllm.example/settings/billing?checkout=returned'}),expect.objectContaining({idempotencyKey:expect.stringContaining(alice)}));
    expect((await storedSubscription()).plan_id).toBe('trial');
    await processBillingEvent(event('evt_checkout_return','checkout.session.completed'));
    expect((await storedSubscription()).plan_id).toBe('trial');
  });
  it('prevents another checkout when a subscription or a different plan checkout is open',async()=>{
    subscriptions.mockResolvedValueOnce({data:[subscription()]} as never);
    await expect(createCheckout(alice,'alice@example.test','starter')).rejects.toMatchObject({status:409});
    expect(checkoutCreate).not.toHaveBeenCalled();
    checkoutList.mockResolvedValue({data:[{mode:'subscription',url:'https://checkout.stripe.com/pending',metadata:{taskllm_plan_id:'pro'}}]} as never);
    await expect(createCheckout(alice,'alice@example.test','starter')).rejects.toMatchObject({status:409});
    expect(await createCheckout(alice,'alice@example.test','pro')).toEqual({url:'https://checkout.stripe.com/pending'});
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
  it('rejects missing and suspended accounts and only opens the account’s own portal',async()=>{
    expect(await createPortal(alice)).toMatchObject({url:'https://billing.stripe.com/local-fixture'});
    expect(portalCreate).toHaveBeenCalledWith({customer:'cus_alice',return_url:'https://taskllm.example/settings/billing'});
    await expect(createPortal('22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({status:400});
    await state.db.query('update profiles set suspended=true where id=$1',[alice]);
    await expect(createCheckout(alice,'alice@example.test','pro')).rejects.toMatchObject({status:403});
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
  it('applies verified subscription state once and deduplicates repeated webhook delivery',async()=>{
    subscriptions.mockResolvedValue({data:[subscription()]} as never);
    await processBillingEvent(event('evt_once'));
    await processBillingEvent(event('evt_once'));
    expect((await storedSubscription()).plan_id).toBe('pro');
    expect(subscriptions).toHaveBeenCalledTimes(1);
    expect((await state.db.query('select * from payment_events')).rows).toHaveLength(1);
    expect((await state.db.query("select * from audit_events where action='billing.synced'")).rows).toHaveLength(1);
  });
  it('re-reads current Stripe state for stale delivery and revokes cancelled subscriptions',async()=>{
    subscriptions.mockResolvedValueOnce({data:[subscription()]} as never);
    await processBillingEvent(event('evt_recent','customer.subscription.updated',300));
    subscriptions.mockResolvedValueOnce({data:[subscription({status:'canceled'})]} as never);
    await processBillingEvent(event('evt_stale','customer.subscription.updated',100));
    expect((await storedSubscription()).status).toBe('canceled');
    const row=(await state.db.query<{last_event_created:number}>('select last_event_created from subscriptions')).rows[0];
    expect(Number(row.last_event_created)).toBe(300);
  });
  it('fails closed for unrecognized prices and ambiguous multi-item subscriptions',async()=>{
    subscriptions.mockResolvedValue({data:[subscription({items:{data:[{quantity:1,price:{id:'price_arbitrary'},current_period_end:9999999999}]} as Stripe.Subscription['items']})]} as never);
    await processBillingEvent(event('evt_unknown_price'));
    expect(await storedSubscription()).toMatchObject({plan_id:'trial',status:'inactive'});
    subscriptions.mockResolvedValue({data:[subscription({items:{data:[{quantity:2,price:{id:'price_pro'},current_period_end:9999999999}]} as Stripe.Subscription['items']})]} as never);
    await processBillingEvent(event('evt_wrong_quantity'));
    expect(await storedSubscription()).toMatchObject({plan_id:'trial',status:'inactive'});
  });
  it('rolls back failed processing so Stripe can retry, and deduplicates payment notifications',async()=>{
    subscriptions.mockRejectedValueOnce(new Error('Temporary Stripe failure'));
    await expect(processBillingEvent(event('evt_retry'))).rejects.toThrow();
    expect((await state.db.query('select * from payment_events')).rows).toHaveLength(0);
    subscriptions.mockResolvedValue({data:[subscription({status:'past_due'})]} as never);
    await processBillingEvent(event('evt_retry','invoice.payment_failed'));
    await processBillingEvent(event('evt_invoice_duplicate','invoice.payment_failed'));
    expect((await state.db.query('select * from notifications')).rows).toHaveLength(1);
    expect((await storedSubscription()).status).toBe('past_due');
  });
});

describe('Webhook verification using the real Stripe signing implementation',()=>{
  const payload=()=>JSON.stringify(event('evt_signature','checkout.session.completed'));
  it('rejects absent, forged, expired or body-mismatched signatures',async()=>{
    expect((await webhook(new Request('https://taskllm.example/api/webhooks/stripe',{method:'POST',body:payload()}))).status).toBe(400);
    for(const signature of ['t=1,v1=forged',stripe().webhooks.generateTestHeaderString({payload:payload(),secret,timestamp:1}),stripe().webhooks.generateTestHeaderString({payload:'{}',secret})]) {
      const response=await webhook(new Request('https://taskllm.example/api/webhooks/stripe',{method:'POST',headers:{'stripe-signature':signature},body:payload()}));
      expect(response.status).toBe(400);
    }
    expect(subscriptions).not.toHaveBeenCalled();
  });
  it('accepts a valid signature without requiring a browser Origin header',async()=>{
    const body=payload();const signature=stripe().webhooks.generateTestHeaderString({payload:body,secret});
    const response=await webhook(new Request('https://taskllm.example/api/webhooks/stripe',{method:'POST',headers:{'stripe-signature':signature},body}));
    expect(response.status).toBe(200);expect(await response.json()).toEqual({received:true});
  });
  it('limits webhook body size before signature verification',async()=>{
    const response=await webhook(new Request('https://taskllm.example/api/webhooks/stripe',{method:'POST',headers:{'stripe-signature':'x','content-length':'1'},body:'x'.repeat(1_000_001)}));
    expect(response.status).toBe(413);
  });
});
