import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeMobileHealthRequest,
  normalizeMobileHealthResponse,
} from '../../packages/server/src/modules/studio/services/chat-run/mobile-health'

describe('mobile health data', () => {
  it('allows only bounded read-only metrics and ranges', () => {
    const now = Date.now()
    const request = normalizeMobileHealthRequest({
      purpose: 'Summarize my week',
      metrics: ['steps', 'sleep', 'steps'],
      start_ms: now - 7 * 24 * 60 * 60_000,
      end_ms: now - 1,
      limit: 500,
    })
    expect(request).toEqual({
      purpose: 'Summarize my week',
      metrics: ['steps', 'sleep'],
      start_ms: now - 7 * 24 * 60 * 60_000,
      end_ms: now - 1,
      limit: 100,
    })
    expect(() => normalizeMobileHealthRequest({ ...request, metrics: ['blood_pressure'] })).toThrow('metrics')
    expect(() => normalizeMobileHealthRequest({ ...request, start_ms: now - 32 * 24 * 60 * 60_000, end_ms: now })).toThrow('31 days')
    expect(() => normalizeMobileHealthRequest({ ...request, start_ms: now - 1, end_ms: now + 60_000 })).toThrow('31 days')
  })

  it('sanitizes App results to exactly the requested metrics and range', () => {
    const expected = {
      purpose: 'test',
      metrics: ['steps', 'heart_rate', 'sleep', 'oxygen_saturation', 'active_energy'] as const,
      start_ms: 1_800_000_000_000,
      end_ms: 1_800_000_100_000,
      limit: 1,
    }
    const response = normalizeMobileHealthResponse({
      status: 'success',
      result: {
        startMs: expected.start_ms,
        endMs: expected.end_ms,
        metrics: {
          steps: { total: 1234.4, secret: 'drop' },
          heart_rate: { average: 72, minimum: 50, maximum: 130, samples: ['drop'] },
          sleep: { totalSeconds: 3600, stageSeconds: { '3': 1200 }, records: [
            { startMs: expected.start_ms, endMs: expected.end_ms, secret: 'drop' },
          ] },
          oxygen_saturation: { latest: 98, latestAtMs: expected.end_ms, secret: 'drop' },
          active_energy: { total: 321.5, secret: 'drop' },
          workouts: [{ secret: 'not requested' }],
        },
      },
    }, { ...expected, metrics: [...expected.metrics] })
    expect(response).toEqual({
      status: 'success',
      result: {
        startMs: expected.start_ms,
        endMs: expected.end_ms,
        metrics: {
          steps: { total: 1234 },
          heart_rate: { average: 72, minimum: 50, maximum: 130 },
          sleep: { totalSeconds: 3600, stageSeconds: { '3': 1200 }, records: [
            { startMs: expected.start_ms, endMs: expected.end_ms },
          ] },
          oxygen_saturation: { latest: 98, latestAtMs: expected.end_ms },
          active_energy: { total: 321.5 },
        },
      },
    })
  })

  it('registers targeted request/response events and an explicit MCP tool', () => {
    const socket = readFileSync(new URL('../../packages/server/src/modules/studio/sockets/chat-run.ts', import.meta.url), 'utf8')
    const mcp = readFileSync(new URL('../../bin/ekko-studio-mcp.mjs', import.meta.url), 'utf8')
    expect(socket).toContain("'health.requested'")
    expect(socket).toContain("socket.on('health.respond'")
    expect(socket).toContain('sameMobileDevice(pending.target, socket.data.mobileDeviceTarget)')
    expect(socket).toContain('Mobile health data is available only in direct chats')
    expect(mcp).toContain("name: 'ekko_studio_use_mobile_health'")
    expect(mcp).toContain('Read-only; no background collection')
    expect(mcp).not.toMatch(/mobile_health[\s\S]{0,500}(write|background access)/i)
    vi.restoreAllMocks()
  })
})
