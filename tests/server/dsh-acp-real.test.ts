import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'
import { prepareDshRuntime, DSH_API_KEY_ENV, DSH_MODEL_PROVIDER } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'

// Opt-in: exercises the installed CLI against a local Responses fixture, without credentials.
describe.skipIf(process.env.DSH_REAL_ACP_E2E !== '1')('installed DSH ACP', () => {
  it('injects a model, emits text, closes and resumes its persisted session in another process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-real-'))
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push(JSON.parse(body))
      const id = `resp_${requests.length}`
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DSH 测试通过', annotations: [] }] }
      const response = { id, object: 'response', status: 'completed', model: 'studio-test', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'DSH 测试通过' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'DSH 测试通过' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    const children: ChildProcess[] = []
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      const home = join(root, 'runtime')
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      const prepared = await prepareDshRuntime({ sourceHome: join(root, 'empty-home'), sharedSkills: join(root, 'shared-skills'),
        rootDir: home, systemPrompt: 'Answer briefly.', managedMcp: {}, model: 'studio-test', reasoningEffort: 'high', baseUrl: `http://127.0.0.1:${port}/v1` })
      let nativeSessionId = ''
      for (let round = 0; round < 2; round++) {
        const child = spawn(process.env.DSH_ACP_E2E_COMMAND || 'dsh', prepared.args, {
          cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', [DSH_API_KEY_ENV]: 'local-fixture-only' },
        })
        children.push(child)
        const exited = once(child, 'close')
        let stderr = ''
        child.stderr?.on('data', chunk => { stderr += chunk.toString() })
        const updates: any[] = []
        const previousId = nativeSessionId
        const turn = new DshAcpTurn(child, { update: update => updates.push(update), session: id => { nativeSessionId = id }, config: () => {} })
        try {
          expect(await turn.prompt({ cwd: workspace, nativeSessionId: previousId || undefined,
            modelValue: JSON.stringify([DSH_MODEL_PROVIDER, 'studio-test']), reasoningEffort: 'high', text: `Test round ${round}`, images: [] })).toBe('end_turn')
          expect(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join('')).toBe('DSH 测试通过')
          expect((await exited)[0], stderr).toBe(0)
          if (round) expect(nativeSessionId).toBe(previousId)
        } catch (error) { throw new Error(`${String(error)}\nDSH stderr: ${stderr}`) }
        finally { turn.dispose() }
      }
      expect(requests).toHaveLength(2)
      expect(requests[0].reasoning?.effort).toBe('high')
      expect(JSON.stringify(requests[0])).toContain('Answer briefly.')
      expect(requests.every(request => request.model === 'studio-test')).toBe(true)
      expect(JSON.stringify(requests[1].input)).toContain('Test round 0')
      expect(JSON.stringify(requests[1].input)).toContain('DSH 测试通过')
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})
