import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  BrowserWindow: class {}, WebContentsView: class {},
  dialog: {}, Menu: {}, session: {}, shell: {},
}))

import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

function setup(contents: unknown) {
  const window = { contentView: { removeChildView: vi.fn() } }
  const manager = new BrowserManager(window as unknown as BrowserWindow, '/tmp/hermes-browser-annotations-test-unused')
  const internal = manager as any
  internal.records.set('tab', { tab: { id: 'tab', url: 'about:blank' }, view: { webContents: contents } })
  internal.activeTabId = 'tab'
  internal.profileStore.list = () => []
  return { manager, internal, window }
}

describe('desktop browser annotation cleanup', () => {
  it.each([undefined, { isDestroyed: () => true, getURL: () => { throw new Error('Destroyed contents accessed') } }])('ignores late loading callbacks after contents have disappeared', contents => {
    const { internal } = setup(contents)
    const record = internal.records.get('tab')
    expect(() => internal.refreshTab(record)).not.toThrow()
    expect(record.tab.url).toBe('about:blank')
  })

  it.each([
    ['missing', undefined],
    ['destroyed', { isDestroyed: () => true, get debugger() { throw new Error('Destroyed debugger accessed') } }],
  ])('closes a %s page with completed and active annotations', async (_state, contents) => {
    const { manager, internal, window } = setup(contents)
    internal.annotationMarkerCounts.set('tab', 2)
    internal.activeAnnotationTabs.add('tab')
    internal.automation.snapshots.set('tab', { id: 'old', refs: new Map() })

    await expect(manager.closeTab('tab')).resolves.toMatchObject({ tabs: [], activeTabId: undefined })
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(internal.annotationMarkerCounts.size).toBe(0)
    expect(internal.activeAnnotationTabs.size).toBe(0)
    expect(internal.automation.snapshots.size).toBe(0)
  })

  it.each(['sync', 'async'])('clears local state after a %s renderer failure', async (failure) => {
    const { manager, internal } = setup({
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: () => {
        if (failure === 'sync') throw new Error('Object has been destroyed')
        return Promise.reject(new Error('Renderer exited'))
      },
    })
    internal.annotationMarkerCounts.set('tab', 1)
    internal.activeAnnotationTabs.add('tab')
    await expect(manager.clearAnnotations('tab')).resolves.toBe(true)
    expect(internal.annotationMarkerCounts.size).toBe(0)
    expect(internal.activeAnnotationTabs.size).toBe(0)
  })

  it('preserves the original selection error if contents disappear during annotation', async () => {
    const failure = new Error('Renderer exited during selection')
    const contents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: async () => {
        internal.records.get('tab').view.webContents = undefined
        throw failure
      },
    }
    const { manager, internal } = setup(contents)
    internal.syncViews = vi.fn()
    await expect(manager.annotate('tab', 'element')).rejects.toBe(failure)
    expect(internal.activeAnnotationTabs.size).toBe(0)
  })
})

describe('desktop browser individual annotation removal', () => {
  function pageSetup() {
    const marks = new Map([1, 2, 3].map(marker => [marker, {
      box: { remove: vi.fn() }, badge: { textContent: `${marker} · note ${marker}` },
    }]))
    const state = { marks, destroy: vi.fn() }
    const execute = vi.fn(async (_world, scripts) => runInNewContext(scripts[0].code, {
      __hermes_browser_annotation_state__: state,
    }))
    const setupResult = setup({ isDestroyed: () => false, executeJavaScriptInIsolatedWorld: execute })
    setupResult.internal.annotationMarkerCounts.set('tab', 3)
    return { ...setupResult, marks, state, execute }
  }

  it('removes only the requested visual marker and keeps surviving numbers and notes', async () => {
    const { manager, internal, marks, state } = pageSetup()
    const removed = marks.get(2)!
    await expect(manager.removeAnnotation('tab', 2)).resolves.toBe(true)
    expect(removed.box.remove).toHaveBeenCalledOnce()
    expect([...marks.keys()]).toEqual([1, 3])
    expect(marks.get(1)?.badge.textContent).toBe('1 · note 1')
    expect(marks.get(3)?.badge.textContent).toBe('3 · note 3')
    expect(internal.annotationMarkerCounts.get('tab')).toBe(3)
    expect(state.destroy).not.toHaveBeenCalled()

    await manager.removeAnnotation('tab', 3)
    expect(internal.annotationMarkerCounts.get('tab')).toBe(1)
    await manager.removeAnnotation('tab', 1)
    expect(state.destroy).toHaveBeenCalledOnce()
    expect(internal.annotationMarkerCounts.has('tab')).toBe(false)
    expect(manager.profileSwitchImpact().pendingAnnotations).toBe(0)
  })

  it('allows retrying a deletion without removing another marker', async () => {
    const { manager, marks } = pageSetup()
    await manager.removeAnnotation('tab', 2)
    await manager.removeAnnotation('tab', 2)
    expect([...marks.keys()]).toEqual([1, 3])
  })

  it('does not restore annotation state if the tab closes during removal', async () => {
    const { manager, internal, execute } = pageSetup()
    execute.mockImplementationOnce(async () => {
      internal.records.delete('tab')
      internal.annotationMarkerCounts.delete('tab')
      return [1, 3]
    })
    await manager.removeAnnotation('tab', 2)
    expect(internal.annotationMarkerCounts.has('tab')).toBe(false)
  })

  it('retains state when removal fails and rejects removal during selection', async () => {
    const { manager, internal, execute } = pageSetup()
    execute.mockRejectedValueOnce(new Error('Renderer exited'))
    await expect(manager.removeAnnotation('tab', 2)).rejects.toThrow('Renderer exited')
    expect(internal.annotationMarkerCounts.get('tab')).toBe(3)
    internal.activeAnnotationTabs.add('tab')
    await expect(manager.removeAnnotation('tab', 2)).rejects.toThrow('already active')
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid marker %s before executing page code', async marker => {
    const { manager, execute } = pageSetup()
    await expect(manager.removeAnnotation('tab', marker)).rejects.toThrow('Invalid browser annotation marker')
    expect(execute).not.toHaveBeenCalled()
  })
})
