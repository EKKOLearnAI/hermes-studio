import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'studio-m0-preset-tools'
export const inject = ['tools', 'skills', 'dynamicCordisRunner']

export function apply(ctx) {
  const counters = new Map()
  const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  ctx.skills.register({ name: 'm0-skill', description: 'M0_PRESET_SKILL', content: 'M0_SKILL_BODY', source: 'bundled' })
  ctx.tools.register(defineTool({
    name: 'm0_counter', description: 'Increment a real dynamic Cordis host plugin counter.', parameters: {}, output,
    async execute(_args, exec) {
      const runner = ctx.dynamicCordisRunner
      const sessionId = exec.agent.session.id
      let active = counters.get(sessionId)
      if (!active) {
        const definition = runner.define({ sessionId, plugin: { kind: 'new', idPrefix: 'probe' },
          name: 'M0 counter', purpose: 'Prove process-local plugin state survives two ACP prompts.',
          code: { host: "return { apply(ctx) { let count = 0; ctx.effect(() => harness.handle('next', () => ++count)) } }" },
        })
        active = await runner.run(exec.agent, definition.pluginId, definition.packageId, 'run', exec.signal)
        if (!active.ok || active.status !== 'running') throw new Error(JSON.stringify(active))
        counters.set(sessionId, active)
      }
      const result = await runner.invoke(active.pluginId, active.pluginRunId, 'next', null)
      if (!result.ok) throw new Error(JSON.stringify(result))
      return { count: result.value, pluginId: active.pluginId, pluginRunId: active.pluginRunId }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'm0_wait', description: 'Wait until the test cancels this tool.', parameters: {}, output,
    async execute(_args, exec) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_ekko/m0/tool_waiting', params: { sessionId: exec.agent.session.id } }) + '\n')
      await new Promise((_, reject) => {
        if (exec.signal.aborted) return reject(exec.signal.reason)
        exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })
    },
  }))
}
