import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  'packages/client/src/components/hermes/connections/AppConnectionsPanel.vue',
  'utf8',
)

describe('App connections scan modal', () => {
  it('offers LAN and cloud QR modes with manual refresh and an expired overlay', () => {
    expect(source).toContain('@click="openScanModal"')
    expect(source).toContain('<NTabPane name="lan"')
    expect(source).toContain('<NTabPane name="cloud"')
    expect(source).toContain('QRCode.toDataURL(response.qr_payload')
    expect(source).toContain("t('connections.app.remainingTime', { time: remainingTime })")
    expect(source).toContain("t('connections.app.refreshQr')")
    expect(source).toContain('authorizationLoading && !lanAuthorization')
    expect(source).toContain('class="connection-meta"')
    expect(source).toContain('CONNECTION_POLL_INTERVAL_MS = 3_000')
    expect(source).toContain("document.visibilityState === 'hidden'")
    expect(source).toContain('detectScanConnection: true')
    expect(source).toContain("t('connections.app.connectionDetected')")
    expect(source).toContain("t('connections.app.connectionStatus')")
    expect(source).toContain("t('connections.app.authorizationStatus')")
    expect(source).toContain('deleteAppConnection(connection.id)')
    expect(source).toContain('<NDataTable')
    expect(source).not.toContain('<NAlert')
    expect(source).toContain('createCloudAppAuthorization(refresh)')
    expect(source).toContain("generateAuthorization('cloud', true)")
    expect(source).toContain("'connection-qr--expired': authorizationExpired")
    expect(source).toContain('style="width: 560px; max-width: calc(100vw - 32px)"')
    expect(source).not.toContain("t('connections.app.authorizationCode')")
    expect(source).not.toContain('<NInput')
    expect(source).not.toContain('authorization.expires_at <= currentTimestamp.value')
  })
})
