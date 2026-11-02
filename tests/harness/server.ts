/** Test-only local infrastructure. Never imported by production code.
 * PostgreSQL is real PGlite; Supabase Auth and paid AI APIs are explicit fixtures.
 * The execution engine is real. This harness does not exercise Redis/BullMQ.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createServer } from 'node:http';
import { randomUUID,createHmac } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function main(){
  Object.assign(process.env,{
    DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:55432/postgres',
    NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:54321',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'test-publishable-key',
    APP_URL:'http://localhost:3001',ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
    OPENAI_API_KEY:'test-only-no-provider-credentials',ANTHROPIC_API_KEY:'test-only-no-provider-credentials',
  });
  const database=new PGlite();
  await database.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated,anon;`);
  const migrations=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
  for(const file of migrations)await database.exec(await readFile(path.join('supabase/migrations',file),'utf8'));
  const socket=new PGLiteSocketServer({db:database,host:'127.0.0.1',port:55432,maxConnections:30});
  await socket.start();
  const accounts=new Map<string,{id:string;email:string;password:string;name:string}>();
  const tokens=new Map<string,string>();
  const publicUser=(a:{id:string;email:string;name:string})=>({id:a.id,email:a.email,aud:'authenticated',role:'authenticated',email_confirmed_at:new Date().toISOString(),created_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{full_name:a.name}});
  function session(account:{id:string;email:string;name:string}){
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({sub:account.id,aud:'authenticated',role:'authenticated',email:account.email,iss:'http://127.0.0.1:54321/auth/v1',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),session_id:randomUUID()})).toString('base64url');
    const token=`${header}.${payload}.${createHmac('sha256','test-only').update(`${header}.${payload}`).digest('base64url')}`;
    tokens.set(token,account.email);
    return {access_token:token,refresh_token:randomUUID(),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:publicUser(account)};
  }
  const auth=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
    try{
      let body='';for await(const chunk of req)body+=String(chunk);const data=body?JSON.parse(body):{};
      const endpoint=new URL(req.url||'/', 'http://localhost').pathname;
      const bearer=req.headers.authorization?.replace('Bearer ','')||'';
      const account=accounts.get(tokens.get(bearer)||'');
      if(endpoint==='/auth/v1/signup'){
        if(accounts.has(data.email))return send(400,{message:'Account exists'});
        const created={id:randomUUID(),email:data.email,password:data.password,name:data.data?.full_name||'Test User'};
        accounts.set(created.email,created);
        await database.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[created.id,created.email,JSON.stringify({full_name:created.name})]);
        // A small real entitlement fixture allows testing mocked AI accounting.
        await database.query("insert into subscriptions(user_id,plan_id,status,current_period_end) values($1,'starter','active',now()+interval '1 month')",[created.id]);
        return send(200,session(created));
      }
      if(endpoint==='/auth/v1/token'){
        const found=accounts.get(data.email);if(!found||found.password!==data.password)return send(400,{error_code:'invalid_credentials',msg:'Invalid login credentials'});
        return send(200,session(found));
      }
      if(endpoint==='/auth/v1/user')return account?send(200,publicUser(account)):send(401,{message:'Invalid token'});
      if(endpoint==='/auth/v1/logout'){tokens.delete(bearer);return send(200,{});}
      if(endpoint==='/auth/v1/recover')return send(200,{});
      if(endpoint.endsWith('/.well-known/jwks.json'))return send(200,{keys:[]});
      return send(404,{message:'Test auth endpoint not implemented'});
    }catch{return send(500,{message:'Test auth error'});}
  });
  await new Promise<void>(resolve=>auth.listen(54321,'127.0.0.1',resolve));
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const url=String(input);
    if(url==='https://api.openai.com/v1/responses'){
      return Response.json({model:'gpt-6-luna',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Fixture AI response: customer feedback is positive.'}]}],usage:{input_tokens:30,output_tokens:12}});
    }
    return nativeFetch(input,options);
  };
  const {processExecution}=await import('../../src/server/execution');
  const {getDb,query}=await import('../../src/server/db');
  let busy=false;
  const timer=setInterval(async()=>{
    if(busy)return;busy=true;
    try{const runs=await query<{id:string}>("select id from executions where status='queued' order by created_at limit 1");if(runs[0])await processExecution(runs[0].id);}
    catch(error){console.error('Test worker failed',error instanceof Error?error.message:'unknown');}
    finally{busy=false;}
  },300);
  const web=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3001'],{env:process.env,stdio:'inherit',windowsHide:true});
  let stopping=false;
  async function stop(){if(stopping)return;stopping=true;clearInterval(timer);web.kill();auth.close();await getDb().end();await socket.stop();await database.close();process.exit(0);}
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());web.once('exit',()=>void stop());
  console.log('TaskLLM TEST fixtures: Auth + AI are mocked; PostgreSQL + execution engine are real.');
}
main().catch(error=>{console.error(error);process.exit(1);});
