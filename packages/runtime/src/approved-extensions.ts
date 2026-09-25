import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { impeccableFiles } from '@pi-student/shared/impeccable-bundle';
import { skillCatalog,mcpCatalog } from '@pi-student/shared/extension-catalog';
import { callCatalogMcp } from '@pi-student/shared/catalog-mcp';
import { callPersonalSupabaseMcp, supabaseMcpConnected } from '@pi-student/shared/supabase-mcp-oauth';
import type { StudentRuntimeServices } from './telemetry-integration.js';

export function createApprovedExtensions(services:StudentRuntimeServices={}):ExtensionFactory{
 return pi=>{
  const result=(text:string)=>({content:[{type:'text' as const,text}],details:{}});
  pi.registerTool({name:'school_skill',label:'School skill',description:'Read organization-approved skill instructions and references. Use action=list to discover available skills; action=read with a resource such as SKILL.md to read Impeccable.',parameters:Type.Object({action:Type.Union([Type.Literal('list'),Type.Literal('read')]),resource:Type.Optional(Type.String())}),async execute(_id,params){
   const environment=await services.extensionEnvironment?.();const available=environment?.skills?.filter(skill=>skill.artifactDigest===skillCatalog[0]!.artifactDigest)||[];
   if(params.action==='list')return result(JSON.stringify(available.map(skill=>({name:skill.name,resources:Object.keys(impeccableFiles)}))));
   if(!available.length)throw Error('Impeccable is not enabled for this project.');
   const resource=params.resource||'SKILL.md';if(!Object.hasOwn(impeccableFiles,resource))throw Error('Unknown skill resource.');
   return result('School-approved Markdown guidance. External launchers are unavailable; use the documented fallback and existing sandbox tools. Organization capabilities remain authoritative.\n\n'+impeccableFiles[resource]);
  }});
  pi.registerTool({name:'school_mcp',label:'School connector',description:'Use approved school connectors. List returns connector IDs and tools. Call executes a listed tool with its documented arguments.',parameters:Type.Object({action:Type.Union([Type.Literal('list'),Type.Literal('call')]),connectorId:Type.Optional(Type.String()),tool:Type.Optional(Type.String()),arguments:Type.Optional(Type.Record(Type.String(),Type.Unknown()))}),async execute(_id,params){
   const env=await services.extensionEnvironment?.();const available=(env?.mcps||[]).filter(m=>mcpCatalog.some(c=>c.endpoint===m.endpoint)&&!m.secretReference);
   if(env?.sandbox.internetAllowed===false)throw Error('Internet access is disabled.');
   const allowed=available.filter(m=>!env?.sandbox.blockedHosts?.some(host=>new URL(m.endpoint!).hostname===host||new URL(m.endpoint!).hostname.endsWith('.'+host)));
   const connect=async(m:typeof allowed[number],method:'tools/list'|'tools/call',args:Record<string,unknown>={})=>{
    if(m.endpoint===mcpCatalog.find(item=>item.id==='supabase')?.endpoint){
     const identity=await services.identityProvider?.getIdentity();
     if(!identity?.userId)throw Error('Sign in to Pi Student before connecting Supabase.');
     return callPersonalSupabaseMcp(identity.userId,method,args);
    }
    return callCatalogMcp(m.endpoint!,method,args);
   };
   if(params.action==='list'){const results=[];for(const m of allowed){if(m.endpoint===mcpCatalog.find(item=>item.id==='supabase')?.endpoint){const identity=await services.identityProvider?.getIdentity();if(!identity?.userId||!await supabaseMcpConnected(identity.userId)){results.push({id:m.id,name:m.name,connected:false,tools:[]});continue;}}results.push({id:m.id,name:m.name,connected:true,...await connect(m,'tools/list')});}return result(JSON.stringify(results));}
   const connector=allowed.find(m=>m.id===params.connectorId);if(!connector)throw Error('Connector unavailable for this project.');
   const inventory=await connect(connector,'tools/list');if(!inventory.tools?.some((t:{name:string})=>t.name===params.tool))throw Error('Unknown connector tool.');
   return result(JSON.stringify(await connect(connector,'tools/call',{name:params.tool,arguments:params.arguments||{}})));
  }});
 };
}
