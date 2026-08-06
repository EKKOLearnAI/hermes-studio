import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const firmwareSources = [
  'packages/esp32-c3/v1/src/main.cpp',
  'packages/esp32-c3/v2/src/main.cpp',
]

function readFirmwareSources(): string[] {
  return firmwareSources.map(source => readFileSync(source, 'utf8'))
}

describe('MCU firmware remote reliability', () => {
  it('keeps voice streaming buffers bounded and statically reusable', () => {
    for (const source of readFirmwareSources()) {
      expect(source).toContain('constexpr size_t kListeningPreRollFrames = 4096;')
      expect(source).toContain('constexpr size_t kVoiceStreamChunkFrames = 1024;')
      expect(source).toContain('VoiceStreamChunk voiceStreamScratch;')
      expect(source).toContain('VoiceStreamChunk *pcmChunk = &voiceStreamScratch;')
      expect(source).not.toContain('malloc(sizeof(VoiceStreamChunk))')
      expect(source).not.toContain('free(pcmChunk)')
    }
  })

  it('does not tear down an active remote socket during device discovery', () => {
    for (const source of readFirmwareSources()) {
      expect(source).toContain('Remote discovery using active Socket.IO machine cache')
      expect(source).toContain('restorePersistedActiveRemoteDevice();')
      expect(source).not.toContain('Remote discovery releasing Socket.IO')
      expect(source).not.toContain('Remote discovery reconnecting Socket.IO')
    }
  })

  it('preserves the active remote login across transient Studio disconnects', () => {
    for (const source of readFirmwareSources()) {
      const handler = source.slice(
        source.indexOf('if (type == F("mcu.remote.disconnected"))'),
        source.indexOf('if (type == F("auth.invalid"))'),
      )
      expect(handler).toContain('preserving login for reconnect')
      expect(handler).not.toContain('clearActiveDeviceState();')
    }
  })

  it('reconnects remote sockets with bounded backoff', () => {
    for (const source of readFirmwareSources()) {
      expect(source).toContain('constexpr uint32_t kMcuSocketReconnectMaxMs = 30000;')
      expect(source).toContain('void tickMcuSocketReconnect()')
      expect(source).toContain('mcuSocketReconnectDelayMs = min<uint32_t>(delayMs * 2, kMcuSocketReconnectMaxMs);')
      expect(source).toContain('tickMcuSocketReconnect();')
    }
  })

  it('defers reauthentication and recovers from allocation pressure', () => {
    for (const source of readFirmwareSources()) {
      expect(source).toContain('queueMcuReauth(true, F("auth.invalid")')
      expect(source).toContain('tickMcuReauth();')
      expect(source).toContain('new (std::nothrow) uint8_t[target]')
      expect(source).toContain('new (std::nothrow) uint8_t[static_cast<size_t>(length) + 1]')
      expect(source).toContain('closeMcuSocketTransport(F("frame allocation failed"))')
    }
  })

  it('keeps terminal interaction states from regressing to stale progress', () => {
    for (const source of readFirmwareSources()) {
      expect(source).toContain('if (sameInteraction && currentTerminal && !incomingTerminal)')
      expect(source).toContain('Ignoring stale interaction status')
    }
  })
})
