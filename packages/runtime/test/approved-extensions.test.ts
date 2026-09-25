import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createApprovedExtensions} from '../src/approved-extensions.js';
import {impeccableFiles} from '@pi-student/shared/impeccable-bundle';
import {skillCatalog} from '@pi-student/shared/extension-catalog';
it('pins the shipped Impeccable bundle and rechecks approval on every read',async()=>{
 expect('sha256:'+createHash('sha256').update(JSON.stringify(impeccableFiles)).digest('hex')).toBe(skillCatalog[0].artifactDigest);
 let enabled=true;const tools:any[]=[];
 createApprovedExtensions({extensionEnvironment:async()=>({sandbox:{mode:'host'},skills:enabled?[{id:'skill',name:'Impeccable',artifactDigest:skillCatalog[0].artifactDigest}]:[]})})({registerTool:(t:any)=>tools.push(t)} as any);
 const read=tools.find(t=>t.name==='school_skill').execute;
 expect((await read('1',{action:'read'})).content[0].text).toContain('name: impeccable');
 await expect(read('2',{action:'read',resource:'../../secrets'})).rejects.toThrow('Unknown skill resource');
 enabled=false;await expect(read('3',{action:'read'})).rejects.toThrow('not enabled');
});
it('does not connect to arbitrary registered endpoints',async()=>{
 const tools:any[]=[];const network=vi.spyOn(globalThis,'fetch');
 createApprovedExtensions({extensionEnvironment:async()=>({sandbox:{mode:'host'},mcps:[{id:'untrusted',name:'Other',transport:'http',endpoint:'https://internal.example'}]})})({registerTool:(t:any)=>tools.push(t)} as any);
 await expect(tools.find(t=>t.name==='school_mcp').execute('1',{action:'call',connectorId:'untrusted',tool:'anything'})).rejects.toThrow('unavailable');
 expect(network).not.toHaveBeenCalled();network.mockRestore();
});
