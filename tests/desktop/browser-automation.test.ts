import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { BrowserAutomation } from '../../packages/desktop/src/main/browser/browser-automation'

function fakeContents(options: { attributes?: string[]; protectedValue?: boolean; role?: string; name?: string } = {}): WebContents {
  let attached = false
  const debuggerApi = {
    isAttached: () => attached,
    attach: () => { attached = true },
    detach: () => { attached = false },
    sendCommand: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{
            backendDOMNodeId: 7,
            role: { value: options.role || 'textbox' },
            name: { value: options.name || 'Account secret' },
            value: { value: 'should-not-leak' },
            properties: options.protectedValue ? [{ name: 'protected', value: { value: true } }] : [],
          }],
        }
      }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: options.attributes || [] } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    },
  }
  return {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as unknown as WebContents
}

describe('desktop browser automation safety', () => {
  it('redacts protected accessibility values and rejects stale refs', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ protectedValue: true })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(snapshot.nodes[0].value).toBeUndefined()
    expect(snapshot.text).not.toContain('should-not-leak')
    automation.invalidate('tab-1')
    await expect(automation.interact('tab-1', contents, {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).rejects.toThrow(/stale/)
  })

  it('blocks Agent typing into password and payment fields', async () => {
    const passwordAutomation = new BrowserAutomation()
    const passwordContents = fakeContents({ attributes: ['type', 'password'] })
    const passwordSnapshot = await passwordAutomation.snapshot('password-tab', passwordContents)
    await expect(passwordAutomation.interact('password-tab', passwordContents, {
      action: 'type', snapshot_id: passwordSnapshot.snapshotId, ref: '@e1', text: 'secret',
    })).rejects.toThrow(/password and payment/)

    const paymentAutomation = new BrowserAutomation()
    const paymentContents = fakeContents({ attributes: ['type', 'text', 'name', 'card_number'] })
    const paymentSnapshot = await paymentAutomation.snapshot('payment-tab', paymentContents)
    await expect(paymentAutomation.interact('payment-tab', paymentContents, {
      action: 'type', snapshot_id: paymentSnapshot.snapshotId, ref: '@e1', text: '4111111111111111',
    })).rejects.toThrow(/password and payment/)
  })

  it('clicks a current safe element through its resolved DOM object', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents()
    const snapshot = await automation.snapshot('tab-1', contents)
    await expect(automation.interact('tab-1', contents, {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).resolves.toBeUndefined()
  })

  it('requires user confirmation for high-risk activation labels', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ role: 'button', name: 'Delete account' })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(automation.interactionRisk('tab-1', {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).toEqual({ kind: 'high-risk-activation', label: 'Delete account' })
  })
})
