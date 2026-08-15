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
    expect(source).toContain('<NAlert')
    expect(source).toContain('@close="dismissAccessFailure"')
    expect(source).toContain('DISMISSED_ACCESS_FAILURE_KEY')
    expect(source).toContain('nextFailure.occurredAt > dismissedAccessFailureAt.value')
    expect(source).toContain('accessFailureReason')
    expect(source).toContain("failure.plan === 'internal' || failure.plan === 'public_beta'")
    expect(source).toContain("failure.plan === 'paid' && failure.code === 'app_entitlement_expired'")
    expect(source).toContain('failure.tokenTtlSeconds === 0')
    expect(source).toContain('accessFailureMode')
    expect(source).toContain("t('connections.app.accessFailures.tokenExpired')")
    expect(source).toContain("t('connections.app.accessFailures.paidAccountRequired')")
    expect(source).toContain('createCloudAppAuthorization(refresh)')
    expect(source).toContain("generateAuthorization('cloud', true)")
    expect(source).toContain("'connection-qr--expired': authorizationExpired")
    expect(source).toContain('style="width: 560px; max-width: calc(100vw - 32px)"')
    expect(source).not.toContain("t('connections.app.authorizationCode')")
    expect(source).not.toContain('<NInput')
    expect(source).not.toContain('authorization.expires_at <= currentTimestamp.value')
  })
})
