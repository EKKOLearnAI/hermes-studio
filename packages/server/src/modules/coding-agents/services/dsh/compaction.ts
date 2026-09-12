import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import { isolatedCodingAgentChildEnv } from '../runtime/child-env'
import { updateContextTokenUsage } from '../../../studio/public/run-state'
import { DshAcpTurn } from './acp-turn'
import { DSH_MODEL_PROVIDER } from './runtime-config'
import type { DshTurnHost } from './chat-turn'

type CompactionHost = Pick<DshTurnHost, 'spawn' | 'isRunning' | 'terminate' | 'forceKill' | 'emit' | 'touch' | 'stderr'>

export async function compactDshRun(run: ManagedCodingAgentRun, args: string, host: CompactionHost) {
  if (args.trim()) throw new Error('DSH native /compact does not accept arguments')
  if (run.nativeCompletionPending || run.turnActive || host.isRunning(run.currentChild)) throw new Error('DSH is still processing the previous input')
  const nativeSessionId = run.launch.agentNativeSessionId?.trim()
  if (!nativeSessionId) throw new Error('DSH session has no native history to compact')
  const child = host.spawn(run.launch.command, run.launch.args, {
    cwd: run.launch.workspaceDir, pipeStdin: true,
    env: run.launch.mode === 'global' ? { ...process.env, ...run.launch.env } : isolatedCodingAgentChildEnv(run.launch.env),
  })
  run.currentChild = child
  run.turnActive = true
  const wasWorking = run.state.isWorking
  run.state.isWorking = true
  host.touch()
  const turn = new DshAcpTurn(child, { update: () => {}, session: () => {}, config: () => {}, permissionRequired: run.launch.approvalRequired })
  run.dshTurn = turn
  child.stderr?.on('data', chunk => { host.stderr(chunk); host.touch() })
  let killTimer: ReturnType<typeof setTimeout> | undefined
  child.once('close', () => {
    if (killTimer) clearTimeout(killTimer)
    if (run.currentChild === child) run.currentChild = undefined
  })
  try {
    const result = await turn.compact({
      cwd: run.launch.workspaceDir, nativeSessionId,
      modelValue: run.launch.mode === 'scoped' ? JSON.stringify([DSH_MODEL_PROVIDER, run.launch.model]) : undefined,
      reasoningEffort: run.launch.mode === 'scoped' ? run.launch.reasoningEffort : undefined,
    })
    if (Number.isFinite(result.afterTokens) && !run.exited && !run.stoppedByUser) {
      updateContextTokenUsage(run.launch.sessionId, run.state, host.emit, result.afterTokens!)
    }
    return result
  } catch (error) {
    host.terminate(child)
    throw error
  } finally {
    turn.dispose()
    if (run.dshTurn === turn) run.dshTurn = undefined
    run.turnActive = false
    if (!run.exited && !run.stoppedByUser) run.state.isWorking = wasWorking
    if (host.isRunning(child)) {
      killTimer = setTimeout(() => host.forceKill(child), 1500)
      killTimer.unref()
    }
  }
}
