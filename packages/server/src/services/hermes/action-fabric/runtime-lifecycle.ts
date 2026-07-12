export interface FabricLifecycleHooks { start(): Promise<void>; stop(): Promise<void> }
export interface FabricSerializedLifecycle { start(): Promise<void>; stop(): Promise<void> }

export function createSerializedFabricLifecycle(hooks: FabricLifecycleHooks): FabricSerializedLifecycle {
  let tail = Promise.resolve()
  let active = false
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
  return {
    start() {
      return enqueue(async () => {
        if (active) return
        await hooks.start()
        active = true
      })
    },
    stop() {
      return enqueue(async () => {
        if (!active) return
        await hooks.stop()
        active = false
      })
    },
  }
}
