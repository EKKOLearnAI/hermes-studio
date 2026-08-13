import { describe, expect, it } from 'vitest'
import {
  buildOutboundRunEvent,
  buildResumeEvents,
  buildResumeMessages,
  RESUME_TOOL_RESULT_DISPLAY_LIMIT,
} from '../../packages/server/src/services/hermes/run-chat/resume-payload'

function message(overrides: Record<string, unknown>) {
  return {
    id: 1,
    session_id: 'session-1',
    role: 'tool',
    content: '',
    timestamp: 1,
    ...overrides,
  } as any
}

describe('buildResumeMessages', () => {
  it('truncates only the outbound tool result without mutating session history', () => {
    const completeResult = 'x'.repeat(4_000)
    const persisted = message({ content: completeResult })
    const history = [persisted]

    const outbound = buildResumeMessages(history)

    expect(outbound).not.toBe(history)
    expect(outbound[0]).not.toBe(persisted)
    expect(outbound[0].content).toContain('... (truncated)')
    expect(outbound[0].content.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect((outbound[0] as any).content_truncated).toBe(true)
    expect((outbound[0] as any).content_original_length).toBe(completeResult.length)
    expect(history[0]).toBe(persisted)
    expect(history[0].content).toBe(completeResult)
  })

  it('keeps large JSON valid so the frontend can retain structured rendering', () => {
    const completeResult = JSON.stringify({
      status: 'ok',
      rows: Array.from({ length: 200 }, (_, index) => ({ index, value: 'x'.repeat(80) })),
    })

    const [outbound] = buildResumeMessages([message({ content: completeResult })])
    const parsed = JSON.parse(outbound.content)

    expect(parsed.status).toBe('ok')
    expect(outbound.content.length).toBeLessThanOrEqual(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(outbound.content).toContain('truncated')
  })

  it('does not alter normal chat messages or short tool results', () => {
    const user = message({ role: 'user', content: 'hello' })
    const assistant = message({ role: 'assistant', content: 'world' })
    const tool = message({ content: '{"ok":true}' })

    const outbound = buildResumeMessages([user, assistant, tool])

    expect(outbound[0]).toBe(user)
    expect(outbound[1]).toBe(assistant)
    expect(outbound[2]).toBe(tool)
  })

  it('bounds display_content independently while preserving the original field', () => {
    const completeDisplayContent = 'display-'.repeat(400)
    const persisted = message({ content: 'small', display_content: completeDisplayContent })

    const [outbound] = buildResumeMessages([persisted])

    expect(outbound.display_content).toContain('... (truncated)')
    expect((outbound as any).display_content_truncated).toBe(true)
    expect(persisted.display_content).toBe(completeDisplayContent)
  })

  it('keeps unified diffs intact to match the existing Studio display behavior', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +1 @@',
      ...Array.from({ length: 300 }, () => '-before\n+after'),
    ].join('\n')
    const persisted = message({ content: diff })

    const [outbound] = buildResumeMessages([persisted])

    expect(outbound).toBe(persisted)
    expect(outbound.content).toBe(diff)
  })

  it('truncates the live WebSocket tool event without mutating the internal event', () => {
    const completeOutput = 'live-result-'.repeat(400)
    const internal = {
      event: 'tool.completed',
      session_id: 'session-1',
      output: completeOutput,
      preview: completeOutput,
    }

    const outbound = buildOutboundRunEvent('tool.completed', internal)

    expect(outbound).not.toBe(internal)
    expect(outbound.output.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(outbound.output_truncated).toBe(true)
    expect(outbound.output_original_length).toBe(completeOutput.length)
    expect(outbound.preview.length).toBe(100)
    expect(internal.output).toBe(completeOutput)
    expect(internal.preview).toBe(completeOutput)
  })

  it('truncates replayed live events without changing state.events', () => {
    const completeOutput = 'event-'.repeat(800)
    const stateEvents = [{
      event: 'tool.failed',
      data: { event: 'tool.failed', output: completeOutput, error: 'failed' },
    }]

    const outbound = buildResumeEvents(stateEvents)

    expect(outbound[0]).not.toBe(stateEvents[0])
    expect(outbound[0].data.output.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(stateEvents[0].data.output).toBe(completeOutput)
  })
})
