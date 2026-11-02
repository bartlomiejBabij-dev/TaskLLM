import { NextResponse } from 'next/server';
import { processBillingEvent,stripe } from '@/server/billing';
import { requiredEnv } from '@/server/config';
export async function POST(request:Request) {
  const signature=request.headers.get('stripe-signature');
  if(!signature)return NextResponse.json({error:'Missing signature'},{status:400});
  const reader=request.body?.getReader();if(!reader)return NextResponse.json({error:'Missing body'},{status:400});
  let size=0;const chunks:Uint8Array[]=[];
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1_000_000){await reader.cancel();return NextResponse.json({error:'Body too large'},{status:413});}chunks.push(value);}
  let event;
  try { event=stripe().webhooks.constructEvent(Buffer.concat(chunks),signature,requiredEnv('STRIPE_WEBHOOK_SECRET')); }
  catch {return NextResponse.json({error:'Invalid webhook signature or configuration'},{status:400});}
  try {await processBillingEvent(event);return NextResponse.json({received:true});}
  catch {console.error('Billing webhook processing failed',{eventId:event.id});return NextResponse.json({error:'Retry delivery'},{status:503});}
}
