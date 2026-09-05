import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentUpdatePolicy } from '../../packages/server/src/modules/coding-agents/services/update-policy'
const dirs:string[]=[]
afterEach(async()=>{for(const p of dirs.splice(0))await rm(p,{recursive:true,force:true})})
async function setup(){const dir=await mkdtemp(join(tmpdir(),'update-policy-'));dirs.push(dir);const adapter={ids:()=>['codex'],check:vi.fn(async()=>({success:true,tool:{installed:true,version:'1'},latestVersion:'2',updateAvailable:true})),install:vi.fn(async()=>({success:true,tool:{version:'2'}})),busy:vi.fn(()=>false)};return {dir,adapter,policy:new AgentUpdatePolicy(dir,adapter)}}
it('checks by default without installing and never treats errors as latest',async()=>{
 const {policy,adapter}=await setup();await policy.load();await policy.tick();expect(policy.snapshot().codex.status).toBe('available');expect(adapter.install).not.toHaveBeenCalled()
 adapter.check.mockRejectedValueOnce(new Error('offline'));await policy.tick(true);expect(policy.snapshot().codex.status).toBe('failed');expect(policy.snapshot().codex.latestVersion).toBe('2')
})
it('persists one opt-in switch, waits while busy, stops installing after revocation',async()=>{
 const {policy,adapter,dir}=await setup();await policy.set('codex',true);adapter.busy.mockReturnValue(true);await policy.tick();expect(policy.snapshot().codex.status).toBe('waiting');expect(adapter.install).not.toHaveBeenCalled()
 await policy.set('codex',false);adapter.busy.mockReturnValue(false);await policy.tick();expect(adapter.install).not.toHaveBeenCalled()
 const next=new AgentUpdatePolicy(dir,adapter);await next.load();expect(next.snapshot().codex.autoUpdate).toBe(false)
 await policy.set('codex',true);await policy.tick();expect(adapter.install).toHaveBeenCalledTimes(1)
})
it('validates policy and prevents concurrent scheduler execution',async()=>{const {policy,adapter}=await setup();await expect(policy.set('other',true)).rejects.toThrow();await expect(policy.set('codex','true')).rejects.toThrow();await Promise.all([policy.tick(),policy.tick()]);expect(adapter.check).toHaveBeenCalledTimes(1)})
