import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { syncAuthFailures } from './auth-log-sync.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
Deno.serve(async request=>{
 const send=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}});
 if(request.method==='OPTIONS')return new Response(null,{headers:cors});
 if(request.method!=='POST')return send(405,{error:'POST required.'});
 const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];if(!token)return send(401,{error:'Authentication required.'});
 const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_ANON_KEY')!;
 const opts={auth:{persistSession:false,autoRefreshToken:false}};
 const client=createClient(url,key,{...opts,global:{headers:{Authorization:`Bearer ${token}`}}});
 try{
  const identity=await client.auth.getUser(token);if(identity.error||!identity.data.user)return send(401,{error:'Sign in again.'});
  const allowed=await client.rpc('is_platform_administrator');if(allowed.error||allowed.data!==true)return send(403,{error:'Platform administration required.'});
  if(Number(request.headers.get('content-length'))>4096)return send(413,{error:'Request too large.'});
  const raw=await request.text();if(raw.length>4096)return send(413,{error:'Request too large.'});const body=JSON.parse(raw);
  const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,opts);
  if(body.action==='sync-security'){
   const access=Deno.env.get('SUPABASE_MANAGEMENT_TOKEN');if(!access)return send(200,{available:false,message:'Failed-login monitoring is not connected. Configure SUPABASE_MANAGEMENT_TOKEN for the platform Edge Function.'});
   return send(200,{available:true,...await syncAuthFailures(admin,new URL(url).hostname.split('.')[0],access)});
  }
  if(typeof body.userId!=='string'||! /^[0-9a-f-]{36}$/i.test(body.userId))return send(400,{error:'Invalid user.'});
  const found=await admin.auth.admin.getUserById(body.userId);if(found.error||!found.data.user)return send(404,{error:'Account not found.'});
  if(body.action==='update'){
   const profile=await admin.from('profiles').select('account_deleted_at').eq('id',body.userId).single();
   if(profile.error||profile.data.account_deleted_at)return send(409,{error:'This account is deleted or awaiting cleanup.'});
   if(typeof body.display_name!=='string'||!body.display_name.trim()||body.display_name.length>120||typeof body.email!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))return send(400,{error:'Enter a valid name and email.'});
   const previous=found.data.user;
   const updated=await admin.auth.admin.updateUserById(body.userId,{email:body.email.trim(),user_metadata:{...previous.user_metadata,display_name:body.display_name.trim()}});if(updated.error)throw updated.error;
   const synced=await client.rpc('platform_sync_user_profile',{user_id_input:body.userId,name_input:body.display_name.trim()});
   if(synced.error){const reverted=await admin.auth.admin.updateUserById(body.userId,{email:previous.email,user_metadata:previous.user_metadata});if(reverted.error)throw Error('Profile synchronization failed; authentication change needs administrator review.');throw synced.error;}
   return send(200,{updated:true});
  }
  if(body.action==='delete'){
   if(body.userId===identity.data.user.id)return send(409,{error:'Use another platform administrator to delete this account.'});
   if(body.confirmation!==found.data.user.email)return send(400,{error:'Confirmation email does not match.'});
   const prepared=await client.rpc('platform_prepare_user_deletion',{user_id_input:body.userId});if(prepared.error)throw prepared.error;
   const deleted=await admin.auth.admin.deleteUser(body.userId,true);if(deleted.error)throw Error('Access revoked, but Auth cleanup failed. Retry deletion.');
   return send(200,{deleted:true});
  }
  return send(400,{error:'Unknown action.'});
 }catch(error){return send(400,{error:error instanceof Error?error.message:'Account action failed.'});}
});
