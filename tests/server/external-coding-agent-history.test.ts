import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverExternalCodingAgentHistory,
  externalSessionId,
  parseClaudeHistoryText,
  parseCodexHistoryText,
} from '../../packages/server/src/services/coding-agents/external-history'

describe('external coding-agent history parser', () => {
  it('normalizes Claude user and assistant messages while ignoring tool records', () => {
    const result = parseClaudeHistoryText([
      JSON.stringify({ type: 'summary', sessionId: 'claude-native-1', cwd: 'C:\\repo', timestamp: '2026-08-22T01:00:00.000Z' }),
      JSON.stringify({ type: 'user', sessionId: 'claude-native-1', cwd: 'C:\\repo', timestamp: '2026-08-22T01:01:00.000Z', message: { role: 'user', content: 'Fix the parser' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'claude-native-1', cwd: 'C:\\repo', timestamp: '2026-08-22T01:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', sessionId: 'claude-native-1', cwd: 'C:\\repo', timestamp: '2026-08-22T01:03:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_result', content: 'ignored' }] } }),
    ].join('\n'))

    expect(result).toMatchObject({
      agent: 'claude',
      nativeSessionId: 'claude-native-1',
      workspace: 'C:\\repo',
      title: 'Fix the parser',
      messages: [
        { role: 'user', content: 'Fix the parser' },
        { role: 'assistant', content: 'I will inspect it.' },
      ],
    })
    expect(result?.messages).toHaveLength(2)
  })

  it('normalizes Codex session metadata and text messages', () => {
    const result = parseCodexHistoryText([
      JSON.stringify({ timestamp: '2026-08-22T02:00:00.000Z', type: 'session_meta', payload: { id: 'codex-native-1', cwd: 'C:\\repo' } }),
      JSON.stringify({ timestamp: '2026-08-22T02:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Review the change' } }),
      JSON.stringify({ timestamp: '2026-08-22T02:02:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The change is ready.' } }),
      JSON.stringify({ timestamp: '2026-08-22T02:02:30.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
    ].join('\n'))

    expect(result).toMatchObject({
      agent: 'codex',
      nativeSessionId: 'codex-native-1',
      workspace: 'C:\\repo',
      title: 'Review the change',
      messages: [
        { role: 'user', content: 'Review the change' },
        { role: 'assistant', content: 'The change is ready.' },
      ],
    })
    expect(result?.lastActive).toBe(Math.floor(Date.parse('2026-08-22T02:02:30.000Z') / 1000))
  })

  it('reads the workspace from a real Codex top-level session_meta record', () => {
    const result = parseCodexHistoryText([
      JSON.stringify({
        timestamp: '2026-08-22T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a00902-6122-7033-8931-4562e82d4571',
          cwd: 'C:\\Users\\wkc_1\\Documents\\Codex\\workspace',
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-22T02:01:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Continue in this workspace' },
      }),
    ].join('\n'))

    expect(result).toMatchObject({
      nativeSessionId: '01a00902-6122-7033-8931-4562e82d4571',
      workspace: 'C:\\Users\\wkc_1\\Documents\\Codex\\workspace',
    })
  })

  it('creates a stable database id without exposing the native session id', () => {
    const first = externalSessionId('codex', 'native-id')
    expect(first).toBe(externalSessionId('codex', 'native-id'))
    expect(first).not.toContain('native-id')
    expect(first).not.toBe(externalSessionId('claude', 'native-id'))
  })

  it('reuses unchanged native history files and reparses changed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-external-history-'))
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    const sourcePath = join(projectDir, 'session.jsonl')
    await writeFile(sourcePath, JSON.stringify({
      sessionId: 'claude-cache-1',
      cwd: 'C:\\repo',
      timestamp: '2026-08-22T03:00:00.000Z',
      message: { role: 'user', content: 'First prompt' },
    }) + '\n', 'utf8')

    const first = await discoverExternalCodingAgentHistory({ claudeProjectsDir: root, codexSessionsDir: join(root, 'missing-codex') })
    const second = await discoverExternalCodingAgentHistory({ claudeProjectsDir: root, codexSessionsDir: join(root, 'missing-codex') })
    expect(second[0]).toBe(first[0])

    await writeFile(sourcePath, JSON.stringify({
      sessionId: 'claude-cache-1',
      cwd: 'C:\\repo',
      timestamp: '2026-08-22T03:00:00.000Z',
      message: { role: 'user', content: 'Updated prompt' },
    }) + '\n', 'utf8')
    const changed = await discoverExternalCodingAgentHistory({ claudeProjectsDir: root, codexSessionsDir: join(root, 'missing-codex') })
    expect(changed[0]).not.toBe(first[0])
    expect(changed[0]?.messages[0]?.content).toBe('Updated prompt')
  })
})
