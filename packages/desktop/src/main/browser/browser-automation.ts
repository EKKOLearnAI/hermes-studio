import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  BrowserInteractAction,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserSnapshotNode,
} from './browser-types'
import { publicBrowserUrl, redactBrowserText } from './browser-url'

interface AxNode {
  nodeId?: string
  backendDOMNodeId?: number
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  description?: { value?: string }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

interface StoredSnapshot {
  id: string
  refs: Map<string, { backendDOMNodeId: number; role: string; name: string }>
}

const MAX_SNAPSHOT_NODES = 300
const MAX_SNAPSHOT_TEXT = 24_000
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
const HIGH_RISK_ACTIVATION = /(?:\b(?:buy(?: now)?|purchase|checkout|place order|pay(?: now)?|delete|remove account|publish|post|send|transfer|withdraw|submit order|grant (?:access|permission)|allow access)\b|购买|下单|付款|支付|删除|注销|发布|发送|转账|提现|提交订单|購入|注文|支払|削除|公開|投稿|送信|振込|구매|주문|결제|삭제|게시|전송|송금)/i

function textValue(value: unknown, limit = 500): string {
  return redactBrowserText(value, limit)
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find(item => item.name === name)?.value?.value
}

function keyDescriptor(key: string): { key: string; code: string; keyCode: number } {
  const named: Record<string, [string, number]> = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32],
  }
  const match = named[key]
  if (match) return { key: key === 'Space' ? ' ' : key, code: match[0], keyCode: match[1] }
  const value = key.length === 1 ? key : key.slice(0, 64)
  const upper = value.toUpperCase()
  return { key: value, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : value, keyCode: upper.charCodeAt(0) || 0 }
}

export class BrowserAutomation {
  private readonly snapshots = new Map<string, StoredSnapshot>()

  invalidate(tabId: string): void {
    this.snapshots.delete(tabId)
  }

  detach(tabId: string, contents: WebContents): void {
    this.invalidate(tabId)
    if (contents.debugger.isAttached()) {
      try { contents.debugger.detach() } catch { /* already detached */ }
    }
  }

  async snapshot(tabId: string, contents: WebContents): Promise<BrowserSnapshot> {
    await this.ensureAttached(contents)
    await contents.debugger.sendCommand('Accessibility.enable')
    const response = await contents.debugger.sendCommand('Accessibility.getFullAXTree') as { nodes?: AxNode[] }
    const refs = new Map<string, { backendDOMNodeId: number; role: string; name: string }>()
    const nodes: BrowserSnapshotNode[] = []
    for (const node of response.nodes || []) {
      if (nodes.length >= MAX_SNAPSHOT_NODES || node.ignored || !node.backendDOMNodeId) continue
      const role = textValue(node.role?.value, 80)
      const name = textValue(node.name?.value)
      const protectedValue = property(node, 'protected') === true
      const value = protectedValue ? '' : textValue(node.value?.value)
      if (!role || role === 'none' || role === 'generic' && !name && !value) continue
      const ref = `@e${nodes.length + 1}`
      refs.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name })
      nodes.push({
        ref,
        role,
        name,
        ...(value ? { value } : {}),
        ...(node.description?.value ? { description: textValue(node.description.value) } : {}),
        ...(property(node, 'disabled') === true ? { disabled: true } : {}),
        ...(property(node, 'focused') === true ? { focused: true } : {}),
      })
    }
    const snapshotId = randomUUID()
    this.snapshots.set(tabId, { id: snapshotId, refs })
    const lines = nodes.map(node => {
      const details = [node.name && `name=${JSON.stringify(node.name)}`, node.value && `value=${JSON.stringify(node.value)}`].filter(Boolean)
      return `${node.ref} ${node.role}${details.length ? ` ${details.join(' ')}` : ''}`
    })
    return {
      tabId,
      snapshotId,
      url: publicBrowserUrl(contents.getURL()),
      title: redactBrowserText(contents.getTitle()),
      nodes,
      text: lines.join('\n').slice(0, MAX_SNAPSHOT_TEXT),
    }
  }

  async interact(tabId: string, contents: WebContents, action: BrowserInteractAction): Promise<void> {
    if (!action || !['click', 'type', 'press', 'scroll'].includes(action.action)) throw new Error('Invalid browser interaction action')
    await this.ensureAttached(contents)
    if (action.action === 'click' || action.action === 'type') {
      if (typeof action.snapshot_id !== 'string' || typeof action.ref !== 'string') throw new Error('snapshot_id and ref are required')
      if (action.action === 'type' && typeof action.text !== 'string') throw new Error('text is required for browser typing')
      const backendNodeId = this.resolveRef(tabId, action.snapshot_id, action.ref).backendDOMNodeId
      const objectId = await this.resolveObject(contents, backendNodeId)
      try {
        if (action.action === 'click') {
          const response = await contents.debugger.sendCommand('Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function () {
              const rect = this.getBoundingClientRect();
              if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('Element is not visible');
              this.scrollIntoView({ block: 'center', inline: 'center' });
              const next = this.getBoundingClientRect();
              if (next.bottom <= 0 || next.right <= 0 || next.top >= innerHeight || next.left >= innerWidth) throw new Error('Element is outside the viewport');
              this.click();
              return true;
            }`,
          }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
          if (response.exceptionDetails || response.result?.value !== true) throw new Error('Unable to click browser element')
        } else {
          await contents.debugger.sendCommand('Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function () {
              this.scrollIntoView({ block: 'center', inline: 'center' });
              this.focus();
              if ('value' in this) {
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value')?.set;
                if (setter) setter.call(this, ''); else this.value = '';
                this.dispatchEvent(new Event('input', { bubbles: true }));
              } else if (this.isContentEditable) {
                this.textContent = '';
              }
              return true;
            }`,
          })
          await contents.debugger.sendCommand('Input.insertText', { text: String(action.text).slice(0, 100_000) })
        }
      } finally {
        await contents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined)
      }
      this.invalidate(tabId)
      return
    }

    if (action.action === 'scroll') {
      if (!['up', 'down', 'left', 'right'].includes(action.direction)) throw new Error('Invalid browser scroll direction')
      const pixels = Math.max(1, Math.min(10_000, Math.round(action.pixels || 650)))
      const deltaX = action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0
      const deltaY = action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0
      await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
        returnByValue: true,
      })
      this.invalidate(tabId)
      return
    }

    if (typeof action.key !== 'string' || !action.key.trim()) throw new Error('key is required for browser key presses')
    const parts = action.key.split('+').map(value => value.trim()).filter(Boolean)
    const key = parts.pop() || 'Enter'
    const modifiers = parts.reduce((mask, item) => mask | ({ alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 }[item.toLowerCase()] || 0), 0)
    const descriptor = keyDescriptor(key)
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode })
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode })
    this.invalidate(tabId)
  }

  interactionRisk(tabId: string, action: BrowserInteractAction): { kind: 'high-risk-activation'; label: string } | null {
    if (action.action !== 'click' || typeof action.snapshot_id !== 'string' || typeof action.ref !== 'string') return null
    const target = this.resolveRef(tabId, action.snapshot_id, action.ref)
    if (!['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio'].includes(target.role.toLowerCase())) return null
    const label = textValue(target.name, 160)
    return label && HIGH_RISK_ACTIVATION.test(label) ? { kind: 'high-risk-activation', label } : null
  }

  async screenshot(tabId: string, contents: WebContents, fullPage = false): Promise<BrowserScreenshot> {
    await this.ensureAttached(contents)
    const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssContentSize?: { width?: number; height?: number }
    }
    const source = fullPage
      ? { width: metrics.cssContentSize?.width, height: metrics.cssContentSize?.height }
      : { width: metrics.cssVisualViewport?.clientWidth, height: metrics.cssVisualViewport?.clientHeight }
    let width = Math.max(1, Math.min(8192, Math.ceil(source.width || 1)))
    let height = Math.max(1, Math.min(8192, Math.ceil(source.height || 1)))
    const maxPixels = 32_000_000
    if (width * height > maxPixels) height = Math.max(1, Math.floor(maxPixels / width))
    let response: { data?: string }
    let screenshotTimer: NodeJS.Timeout | undefined
    try {
      response = await Promise.race([
        contents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: fullPage,
          ...(fullPage ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
        }) as Promise<{ data?: string }>,
        new Promise<never>((_resolve, reject) => {
          screenshotTimer = setTimeout(() => reject(new Error('Browser screenshot timed out')), 15_000)
          screenshotTimer.unref?.()
        }),
      ])
    } catch (error) {
      this.detach(tabId, contents)
      throw error
    } finally {
      if (screenshotTimer) clearTimeout(screenshotTimer)
    }
    const data = response.data || ''
    if (!data) throw new Error('Browser screenshot was empty')
    if (Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds the 12 MB safety limit')
    return { tabId, url: publicBrowserUrl(contents.getURL()), title: redactBrowserText(contents.getTitle()), mediaType: 'image/png', data, width, height }
  }

  private async ensureAttached(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) throw new Error('Browser tab is closed')
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('DOM.enable')
  }

  private resolveRef(tabId: string, snapshotId: string, ref: string): { backendDOMNodeId: number; role: string; name: string } {
    const stored = this.snapshots.get(tabId)
    if (!stored || stored.id !== snapshotId) throw new Error('Browser snapshot is stale; take a new snapshot before interacting')
    const target = stored.refs.get(ref)
    if (!target) throw new Error(`Unknown browser element reference: ${ref}`)
    return target
  }

  private async resolveObject(contents: WebContents, backendNodeId: number): Promise<string> {
    const response = await contents.debugger.sendCommand('DOM.resolveNode', { backendNodeId }) as { object?: { objectId?: string } }
    if (!response.object?.objectId) throw new Error('Browser element is no longer available')
    return response.object.objectId
  }

}
