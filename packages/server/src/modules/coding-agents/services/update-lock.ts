const locks = new Set<string>()
export function agentUpdateLocked(id: string): boolean { return locks.has(id) }
export function lockAgentUpdate(id: string): () => void {
  if(locks.has(id))throw new Error('Agent update is already running')
  locks.add(id)
  return ()=>locks.delete(id)
}
