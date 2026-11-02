import { NextResponse } from 'next/server';
import { hasAppConfig } from '@/server/config';
import { query } from '@/server/db';
export const dynamic='force-dynamic';
export async function GET() {
  if(!hasAppConfig())return NextResponse.json({status:'configuration_required'},{status:503});
  try {await query('select 1');return NextResponse.json({status:'ok'},{headers:{'Cache-Control':'no-store'}});}
  catch{return NextResponse.json({status:'unavailable'},{status:503});}
}
