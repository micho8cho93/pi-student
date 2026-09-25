import {createHash} from 'node:crypto';
import type {SupabaseClient} from 'npm:@supabase/supabase-js@2.116.0';
export const authFailureQuery = `select toStartOfInterval(timestamp, INTERVAL 15 MINUTE) as window, log_attributes['remote_addr'] as address, if(uniqExactIf(log_attributes['auth_event.actor_username'], log_attributes['auth_event.actor_username'] != '') = 1, max(log_attributes['auth_event.actor_username']), '') as email, count() as failures from logs where source='auth_logs' and log_attributes['path'] in ('/token','/callback','/verify') and toInt32OrZero(log_attributes['status']) in (400,401,403) and log_attributes['remote_addr'] != '' group by window,address having failures >= 5 order by window desc limit 1000`;
export async function syncAuthFailures(db:SupabaseClient,projectRef:string,accessToken:string,fetcher:typeof fetch=fetch){
 const end=new Date(),start=new Date(end.getTime()-24*60*60*1000);
 const url=new URL('https://api.supabase.com/v1/projects/'+encodeURIComponent(projectRef)+'/analytics/endpoints/logs');
 url.searchParams.set('sql',authFailureQuery);url.searchParams.set('iso_timestamp_start',start.toISOString());url.searchParams.set('iso_timestamp_end',end.toISOString());
 const response=await fetcher(url,{headers:{Authorization:'Bearer '+accessToken},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Auth log import failed ('+response.status+').');
 const data=await response.json() as {result?:Array<{window:string;address:string;email:string;failures:number}>};
 if(!Array.isArray(data.result))throw Error('Unexpected Auth log response.');
 for(const row of data.result){const key=createHash('sha256').update(projectRef+':'+row.window+':'+row.address).digest('hex');const {error}=await db.rpc('ingest_auth_failure_alert',{email_input:row.email||null,event_key_input:key,count_input:Number(row.failures)});if(error)throw error;}
 return {imported:data.result.length,checkedAt:end.toISOString()};
}
