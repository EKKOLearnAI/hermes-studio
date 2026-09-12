import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify, isSeq } from 'yaml'
import { describe, expect, it } from 'vitest'
import { ProbeRpc } from '../fixtures/dsh-m0/rpc'
import { prepareDshRuntime, DSH_API_KEY_ENV, DSH_MODEL_PROVIDER } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'

const fixtures = resolve('tests/fixtures/dsh-m0')
const runtime = resolve(process.env.DSH_M0_RUNTIME || join(fixtures, 'runtime'))
const modules = join(runtime, 'node_modules')
const pkg = (name: string) => join(modules, '@deepseek-ai', name)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** An opt-in, exact-release experiment, not an alternate production launcher. */
describe.skipIf(process.env.DSH_M0_REAL !== '1')('DSH M0 published rc.1', () => {
  it('binds presets and preserves dynamic plugin state, cancellation and flushed history', async () => {
    const upstream = JSON.parse(await readFile(join(fixtures, 'upstream.json'), 'utf8'))
    const lock = JSON.parse(await readFile(join(fixtures, 'runtime/package-lock.json'), 'utf8'))
    const actualLock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'))
    expect(actualLock.packages).toEqual(lock.packages)
    const versions: Record<string, string> = {}
    for (const [path, entry] of Object.entries<any>(lock.packages)) {
      if (!path.startsWith('node_modules/@deepseek-ai/dsh')) continue
      const manifest = JSON.parse(await readFile(join(runtime, path, 'package.json'), 'utf8'))
      expect(manifest.version, path).toBe(entry.version)
      versions[manifest.name] = manifest.version
    }
    const published = await readFile(join(pkg('dsh-acp'), 'lib/index.js'), 'utf8')
    expect(sha256(published)).toBe(upstream.sha256)
    // Public import surfaces, not type declarations for unpublished subpaths.
    const exports = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      const acp = await import('@deepseek-ai/dsh-acp');
      const presets = await import('@deepseek-ai/dsh-agent-presets');
      console.log(JSON.stringify({acp: Object.keys(acp), mount: typeof presets.AgentPresets.prototype.mount,
        composeFrom: typeof presets.AgentPresets.prototype.composeFrom}));
    `], { cwd: runtime, encoding: 'utf8' }))
    expect(exports).toMatchObject({ mount: 'function', composeFrom: 'function' })
    expect(exports.acp).not.toContain('AcpSession')

    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-m0-'))
    const children: ChildProcess[] = []
    const requests: any[] = []
    const outcomes: any[] = []
    const measurements: Record<string, number> = {}
    let script: Array<{ name?: string; args?: object; text?: string }> = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push(JSON.parse(body))
      const step = script.shift()
      if (!step) { res.writeHead(500); res.end('Unexpected model request'); return }
      const id = `resp_${requests.length}`
      const item: any = step.name
        ? { id: `fc_${id}`, type: 'function_call', call_id: `call_${id}`, name: step.name, arguments: JSON.stringify(step.args || {}), status: 'completed' }
        : { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text || 'M0 done', annotations: [] }] }
      const response = { id, object: 'response', status: 'completed', model: 'studio-test', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      const events: any[] = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: step.name ? { ...item, arguments: '' } : { ...item, content: [] } },
      ]
      if (step.name) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments })
      else events.push(
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: step.text || 'M0 done' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: step.text || 'M0 done' },
      )
      events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      const home = join(root, 'runtime')
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      await mkdir(join(root, 'source'))
      await symlink(modules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      const prepared = await prepareDshRuntime({ sourceHome: join(root, 'source'), sharedSkills: join(root, 'skills'),
        rootDir: home, systemPrompt: 'M0 local fixture.', managedMcp: {}, model: 'studio-test', baseUrl: `http://127.0.0.1:${port}/v1` })
      await writeFile(join(root, 'acp.mjs'), published)
      // A maintained, hash-checked build-time fork. Never edits an installed package.
      execFileSync('git', ['apply', '--no-index', join(fixtures, 'acp-rc1.patch')], { cwd: root })
      await copyFile(join(fixtures, 'preset-tools.mjs'), join(root, 'preset-tools.mjs'))
      const presetDir = join(root, 'presets/probe')
      await mkdir(presetDir, { recursive: true })
      await writeFile(join(presetDir, 'preset.yml'), 'name: M0 probe\ndescription: Local compatibility fixture\n')
      await writeFile(join(presetDir, 'agent.cordis.yml'), stringify([
        { id: 'm0-tools', name: pathToFileURL(join(root, 'preset-tools.mjs')).href },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      ]))

      // Retain the official Web agent-plane overrides; explicitly select only
      // the two host services needed by this M0 experiment. This is not M1's resolver.
      const webText = await readFile(join(pkg('dsh-web-app'), 'cordis.patch.yml'), 'utf8')
      const web = parseDocument(webText, { logLevel: 'silent' })
      if (!isSeq(web.contents)) throw new Error('Unexpected Web composition format')
      const omitted: string[] = []
      for (const row of web.contents.items as any[]) {
        const inserted = row.get('insert')
        if (!isSeq(inserted)) continue
        inserted.items = inserted.items.filter((entry: any) => {
          const keep = ['agent-presets', 'cordis-host-runner'].includes(String(entry.get('id')))
          if (!keep) omitted.push(String(entry.get('id')))
          return keep
        })
      }
      await writeFile(join(root, 'web-host.yml'), String(web))
      const overlay = (preset: string | null) => stringify([
        { id: 'agent-presets', config: { default: 'probe', roots: [{ path: join(root, 'presets'), trust: 'user' }], includeShippedRoot: true, includeUserRoot: false } },
        { id: 'acp', disabled: true },
        { insert: [{ id: 'studio-m0-acp', name: pathToFileURL(join(root, 'acp.mjs')).href, inject: ['agentPresets', 'dynamicCordisRunner'],
          config: { provider: DSH_MODEL_PROVIDER, model: 'studio-test', ...(preset ? { agentPreset: preset } : {}) } }] },
      ])
      const start = async (preset: string | null = 'probe') => {
        const selection = join(root, `selection-${children.length}.yml`)
        await writeFile(selection, overlay(preset))
        const before = performance.now()
        const child = spawn(process.execPath, [join(pkg('dsh'), 'lib/bin.js'), ...prepared.args,
          '--patch', join(root, 'web-host.yml'), '--patch', selection], {
          cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, DSH_HOME: home,
            DSH_TELEMETRY_DISABLED: '1', [DSH_API_KEY_ENV]: 'local-fixture-only' },
        })
        children.push(child)
        const rpc = new ProbeRpc(child)
        expect(await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1 })
        expect(await rpc.request('_ekko/m0/capabilities')).toMatchObject({ version: 1, experimental: true, flushBarrier: true, pid: child.pid })
        measurements[`initialize${children.length}Ms`] = performance.now() - before
        return rpc
      }
      const rpc = await start()
      const session = await rpc.request('session/new', { cwd: workspace, mcpServers: [] })
      const sessionId = session.sessionId
      const prompt = async (client: ProbeRpc, text: string, expectedCount?: number, loadSkill = false) => {
        const offset = requests.length
        const notificationOffset = client.notifications.length
        script = [ ...(loadSkill ? [{ name: 'skill', args: { name: 'm0-skill' } }] : []),
          ...(expectedCount !== undefined ? [{ name: 'm0_counter' }] : []), { text: `M0 ${text}` } ]
        const before = performance.now()
        expect(await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).toEqual({ stopReason: 'end_turn' })
        measurements[`${text}Ms`] = performance.now() - before
        const output = client.notifications.slice(notificationOffset).filter(event => event.method === 'session/update'
          && event.params.sessionId === sessionId && event.params.update.sessionUpdate === 'agent_message_chunk')
        expect(output.map(event => event.params.update.content.text).join('')).toBe(`M0 ${text}`)
        const batch = requests.slice(offset)
        expect(batch).toHaveLength((loadSkill ? 1 : 0) + (expectedCount !== undefined ? 1 : 0) + 1)
        expect(batch[0].tools.map((tool: any) => tool.name)).toContain('m0_counter')
        expect(JSON.stringify(batch[0])).toContain('M0_PRESET_SKILL')
        if (loadSkill) expect(JSON.stringify(batch[1].input)).toContain('M0_SKILL_BODY')
        if (expectedCount !== undefined) {
          const lastOutput = batch.at(-1).input.filter((entry: any) => entry.type === 'function_call_output').at(-1)
          expect(lastOutput.output, client.stderr).toMatch(/^\{/)
          const result = JSON.parse(lastOutput.output)
          expect(result).toMatchObject({ count: expectedCount })
          outcomes.push(result)
        }
      }
      await prompt(rpc, 'first', 1, true)
      const first = await rpc.request('_ekko/m0/state', { sessionId })
      expect(first).toMatchObject({ pid: rpc.child.pid, sessionId, preset: 'probe' })
      expect(first.plugins).toHaveLength(1)
      await prompt(rpc, 'second', 2)
      expect(await rpc.request('_ekko/m0/state', { sessionId })).toEqual(first)
      expect(outcomes[0].pluginRunId).toBe(outcomes[1].pluginRunId)
      expect(rpc.sent.filter(message => message.method === 'initialize')).toHaveLength(1)
      expect(children).toHaveLength(1)

      script = [{ name: 'm0_wait' }]
      const waiting = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'cancel-test' }] })
      await expect.poll(() => rpc.notifications.some(event => event.method === '_ekko/m0/tool_waiting'), { timeout: 10_000 }).toBe(true)
      const cancelAt = performance.now()
      rpc.notify('session/cancel', { sessionId })
      expect(await waiting).toEqual({ stopReason: 'cancelled' })
      measurements.cancelMs = performance.now() - cancelAt
      await prompt(rpc, 'after-cancel', 3)
      expect(await rpc.request('_ekko/m0/state', { sessionId })).toEqual(first)
      const exited = once(rpc.child, 'close')
      rpc.child.kill('SIGKILL')
      await exited

      const resumed = await start()
      await resumed.request('session/resume', { sessionId, cwd: workspace, mcpServers: [] })
      expect(await resumed.request('_ekko/m0/state', { sessionId })).toMatchObject({ sessionId, preset: 'probe', plugins: [] })
      await prompt(resumed, 'resumed', 1, true)
      const resumedInput = JSON.stringify(requests.at(-1).input)
      expect(resumedInput).toContain('M0 after-cancel')
      expect(resumedInput).toContain('M0 first')
      // Native run IDs can restart at run-1: only the runtime generation makes
      // their identity unique. Empty inventory before this prompt proves no replay.
      expect(resumed.child.pid).not.toBe(rpc.child.pid)
      await resumed.request('session/close', { sessionId })
      const closed = once(resumed.child, 'close')
      resumed.child.stdin!.end()
      expect((await closed)[0], resumed.stderr).toBe(0)

      const plain = await start(null)
      await expect(plain.request('session/resume', { sessionId, cwd: workspace, mcpServers: [] })).rejects.toThrow('preset differs')
      const basic = await plain.request('session/new', { cwd: workspace, mcpServers: [] })
      script = [{ text: 'Basic ACP' }]
      await plain.request('session/prompt', { sessionId: basic.sessionId, prompt: [{ type: 'text', text: 'basic' }] })
      expect((requests.at(-1).tools || []).map((tool: any) => tool.name)).not.toContain('m0_counter')
      expect(JSON.stringify(requests.at(-1))).not.toContain('M0_PRESET_SKILL')
      await plain.request('session/close', { sessionId: basic.sessionId })
      const plainClosed = once(plain.child, 'close')
      plain.child.stdin!.end()
      expect((await plainClosed)[0], plain.stderr).toBe(0)
      const invalid = await start('missing-preset')
      await expect(invalid.request('session/new', { cwd: workspace, mcpServers: [] })).rejects.toThrow(/missing-preset/)
      const invalidClosed = once(invalid.child, 'close')
      invalid.child.stdin!.end()
      expect((await invalidClosed)[0], invalid.stderr).toBe(0)
      expect(requests.every(request => request.model === 'studio-test')).toBe(true)
      expect(sha256(await readFile(join(pkg('dsh-acp'), 'lib/index.js'), 'utf8'))).toBe(upstream.sha256)
      const evidence = { recordedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, versions, exports,
        upstream, patchSha256: sha256(await readFile(join(fixtures, 'acp-rc1.patch'), 'utf8')),
        lockSha256: sha256(await readFile(join(fixtures, 'runtime/package-lock.json'), 'utf8')),
        probeSha256: sha256(await readFile(resolve('tests/server/dsh-m0-real.test.ts'), 'utf8')),
        toolsSha256: sha256(await readFile(join(fixtures, 'preset-tools.mjs'), 'utf8')),
        webPatchSha256: sha256(webText), omittedWebEntries: omitted, measurements, modelRequests: requests.length,
        counters: outcomes.map(value => value.count), checks: ['new-preset', 'resume-preset', 'skill-body', 'same-process-state', 'cancel-continue', 'kill-resume', 'preset-mismatch', 'missing-preset', 'basic-no-preset'] }
      if (process.env.DSH_M0_EVIDENCE) await writeFile(process.env.DSH_M0_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
      console.info('DSH M0 evidence', JSON.stringify({ measurements, counters: evidence.counters, modelRequests: requests.length }))
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const closed = once(child, 'close')
        child.kill('SIGKILL')
        await closed
      }))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
