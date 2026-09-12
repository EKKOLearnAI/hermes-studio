import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'
import { prepareDshRuntime, DSH_API_KEY_ENV, DSH_MODEL_PROVIDER } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'

// Real native compaction, with an isolated home and a local model fixture.
describe.skipIf(process.env.DSH_WEB_REAL !== '1')('DSH native compaction', () => {
  it.each(['scoped', 'global'] as const)('persists a native summary and resumes it in %s mode', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-compact-'))
    const sourceHome = join(root, 'source'), runtime = join(root, 'runtime'), workspace = join(root, 'workspace')
    const requests: any[] = [], children: ChildProcess[] = []
    const summary = 'Checkpoint: keep the deployment region eu-west-1 and the selected blue theme.'
    let summarizing = false, holdSummary = false
    let summaryStarted = () => {}, releaseSummary = () => {}
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push(JSON.parse(body))
      if (summarizing && holdSummary) {
        const released = new Promise<void>(resolve => { releaseSummary = resolve })
        summaryStarted()
        await released
        if (res.destroyed) return
      }
      const id = `resp_${requests.length}`
      const text = summarizing ? summary : 'Original detailed history. '.repeat(160)
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      const response = { id, object: 'response', status: 'completed', model: 'studio-test', output: [item], usage: { input_tokens: 3000, output_tokens: 200, total_tokens: 3200 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    try {
      await mkdir(sourceHome); await mkdir(workspace)
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
      await writeFile(join(sourceHome, 'settings.yaml'), stringify(mode === 'global' ? {
        'agent-default-model': { provider: 'native-web', model: 'studio-test' },
        'llm-pi-ai': { providers: { 'native-web': { apiKeyEnv: DSH_API_KEY_ENV, api: 'openai-responses', baseURL: baseUrl,
          models: [{ id: 'studio-test', input: ['text'], contextWindow: 128000, maxTokens: 8192 }] } } },
      } : {}))
      const prepared = await prepareDshRuntime({ sourceHome, sharedSkills: join(root, 'skills'), rootDir: runtime,
        installationCommand: process.env.DSH_WEB_COMMAND!, systemPrompt: 'Answer without tools.', managedMcp: {},
        model: mode === 'scoped' ? 'studio-test' : undefined, baseUrl })
      let nativeSessionId = ''
      async function operation(compact = false, preset = 'standard', cancelAfter?: Promise<void>) {
        const child = spawn(process.env.DSH_WEB_COMMAND!, prepared.args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: root, ...prepared.env, DSH_TELEMETRY_DISABLED: '1', [DSH_API_KEY_ENV]: 'fixture' } })
        children.push(child)
        const exit = once(child, 'close')
        let stderr = ''
        child.stderr?.on('data', chunk => { stderr += String(chunk) })
        const updates: any[] = []
        const turn = new DshAcpTurn(child, { update: update => updates.push(update), session: id => { nativeSessionId = id }, config: () => {} })
        const input = { cwd: workspace, nativeSessionId: nativeSessionId || undefined, agentPreset: preset,
          modelValue: mode === 'scoped' ? JSON.stringify([DSH_MODEL_PROVIDER, 'studio-test']) : undefined }
        try {
          const pending = compact
            ? turn.compact({ ...input, nativeSessionId })
            : turn.prompt({ ...input, text: 'Keep the deployment region eu-west-1. '.repeat(100), images: [] })
          if (cancelAfter) void cancelAfter.then(() => turn.cancel())
          const result = await pending
          expect((await exit)[0], stderr).toBe(0)
          if (compact) expect(updates.filter(update => update.sessionUpdate === 'agent_message_chunk')).toEqual([])
          return result
        } catch (error) { throw new Error(`${String(error)}\n${stderr}`) }
        finally { turn.dispose(); if (child.exitCode === null) child.kill('SIGKILL') }
      }
      await operation()
      await operation()
      const originalSession = nativeSessionId
      summarizing = true
      holdSummary = true
      const started = new Promise<void>(resolve => { summaryStarted = resolve })
      try { await expect(operation(true, 'standard', started)).rejects.toThrow(/cancel/i) }
      finally { holdSummary = false; releaseSummary() }
      expect(nativeSessionId).toBe(originalSession)
      const result = await operation(true)
      expect(result).toMatchObject({ compacted: true })
      expect((result as any).afterTokens).toBeLessThan((result as any).beforeTokens)
      expect(nativeSessionId).toBe(originalSession)
      summarizing = false
      await operation()
      expect(JSON.stringify(requests.at(-1).input)).toContain(summary)
      expect(nativeSessionId).toBe(originalSession)
      const logs = await readdir(join(runtime, 'sessions'), { recursive: true })
      const history = (await Promise.all(logs.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(runtime, 'sessions', name), 'utf8')))).join('\n')
      expect(history).toContain('compaction/summary')
      expect(history).toContain('compaction/end')
      expect(history).toContain(summary)
      // A preset without a backend must report its actual missing capability.
      nativeSessionId = ''
      await operation(false, 'minimal')
      await expect(operation(true)).rejects.toThrow('does not provide native compaction')
    } finally {
      releaseSummary()
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})
