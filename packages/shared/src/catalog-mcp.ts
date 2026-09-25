import { mcpCatalog } from './extension-catalog.js';
/** Only curated public endpoints: arbitrary registrations never become host fetch targets. */
export async function callCatalogMcp(endpoint:string,method:'tools/list'|'tools/call',params:Record<string,unknown>={},fetcher:typeof fetch=fetch):Promise<any>{
 if(!mcpCatalog.some(item=>item.id==='cloudflare-docs'&&item.endpoint===endpoint))throw Error('This connector requires a personal authenticated connection.');
 let session:string|undefined;
 async function request(method:string,params:Record<string,unknown>,id?:number){
  const response=await fetcher(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(id?{id}:{}),method,params})});
  if(!response.ok)throw Error('Connector could not be reached ('+response.status+').');
  session=response.headers.get('mcp-session-id')||session;
  if(response.status===202||!id){await response.body?.cancel();return;}
  const reader=response.body?.getReader();let raw='';if(!reader)throw Error('Empty connector response.');const decoder=new TextDecoder();
  while(true){const part=await reader.read();if(part.done)break;raw+=decoder.decode(part.value,{stream:true});if(raw.length>1000000){await reader.cancel();throw Error('Connector response too large.');}}
  const value=response.headers.get('content-type')?.includes('text/event-stream')?raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))).find(item=>item.id===id):JSON.parse(raw);
  if(!value||value.error)throw Error(value?.error?.message||'Invalid connector response.');return value.result;
 }
 await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'pi-student',version:'0.1.0'}},1);
 await request('notifications/initialized',{});
 return request(method,params,2);
}
