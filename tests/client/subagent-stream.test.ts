// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { reduceSubagentStream } from '@/stores/hermes/chat'
import {
  OPEN_SUBAGENT_STREAM_EVENT,
  openSubagentStream,
  subagentIdFromToolCall,
  type OpenSubagentStreamDetail,
} from '@/utils/hermes/subagent-stream'

describe('background subagent streams', () => {
  it('coalesces live text while preserving thinking and tool calls as structured entries', () => {
    let stream = reduceSubagentStream(undefined, 'session-1', {
      event: 'subagent.start',
      subagent_id: 'child-1',
      task_index: 0,
      task_count: 2,
      goal: 'Inspect the updater',
      model: 'test-model',
      background_seq: 1,
      timestamp: 1_000,
    })
    stream = reduceSubagentStream(stream, 'session-1', {
      event: 'subagent.text',
      subagent_id: 'child-1',
      text: 'Found ',
      background_seq: 2,
    })
    stream = reduceSubagentStream(stream, 'session-1', {
      event: 'subagent.text',
      subagent_id: 'child-1',
      text: 'the worker.',
      background_seq: 3,
    })
    stream = reduceSubagentStream(stream, 'session-1', {
      event: 'subagent.thinking',
      subagent_id: 'child-1',
      text: 'Checking shutdown ordering',
      background_seq: 4,
    })
    stream = reduceSubagentStream(stream, 'session-1', {
      event: 'subagent.tool',
      subagent_id: 'child-1',
      tool: 'read_file',
      arguments: { path: 'shutdown.ts' },
      preview: 'shutdown.ts',
      tool_count: 1,
      background_seq: 5,
    })

    expect(stream).toMatchObject({
      sessionId: 'session-1',
      subagentId: 'child-1',
      taskIndex: 0,
      taskCount: 2,
      goal: 'Inspect the updater',
      model: 'test-model',
      status: 'running',
      toolCount: 1,
    })
    expect(stream.entries.filter(entry => entry.kind === 'text')).toHaveLength(1)
    expect(stream.entries.find(entry => entry.kind === 'text')?.text).toBe('Found the worker.')
    expect(stream.entries.find(entry => entry.kind === 'thinking')?.text).toBe('Checking shutdown ordering')
    expect(stream.entries.find(entry => entry.kind === 'tool')).toMatchObject({
      toolName: 'read_file',
      toolArgs: { path: 'shutdown.ts' },
    })
  })

  it('marks terminal updates without replaying an older background event', () => {
    const running = reduceSubagentStream(undefined, 'session-1', {
      event: 'subagent.text',
      subagent_id: 'child-1',
      text: 'working',
      background_seq: 10,
    })
    const completed = reduceSubagentStream(running, 'session-1', {
      event: 'subagent.complete',
      subagent_id: 'child-1',
      status: 'completed',
      summary: 'Done safely',
      duration_seconds: 12.5,
      input_tokens: 100,
      output_tokens: 25,
      background_seq: 11,
    })
    const stale = reduceSubagentStream(completed, 'session-1', {
      event: 'subagent.text',
      subagent_id: 'child-1',
      text: 'stale',
      background_seq: 9,
    })

    expect(completed).toMatchObject({
      status: 'completed',
      summary: 'Done safely',
      durationSeconds: 12.5,
      inputTokens: 100,
      outputTokens: 25,
    })
    expect(completed.entries.at(-1)).toMatchObject({ kind: 'status', status: 'completed' })
    expect(stale).toBe(completed)

    const lateOutput = reduceSubagentStream(completed, 'session-1', {
      event: 'subagent.text',
      subagent_id: 'child-1',
      text: 'late output',
      background_seq: 7,
    })
    expect(lateOutput).toBe(completed)
  })

  it('opens only subagent tool calls in the live output panel', () => {
    expect(subagentIdFromToolCall('subagent:child-1')).toBe('child-1')
    expect(subagentIdFromToolCall('tool:child-1')).toBeNull()

    const listener = vi.fn<(event: Event) => void>()
    window.addEventListener(OPEN_SUBAGENT_STREAM_EVENT, listener)
    expect(openSubagentStream('session-1', 'subagent:child-1')).toBe(true)
    expect(openSubagentStream('session-1', 'tool:child-1')).toBe(false)
    window.removeEventListener(OPEN_SUBAGENT_STREAM_EVENT, listener)

    const event = listener.mock.calls[0]?.[0] as CustomEvent<OpenSubagentStreamDetail>
    expect(event.detail).toEqual({ sessionId: 'session-1', subagentId: 'child-1' })
  })
})
