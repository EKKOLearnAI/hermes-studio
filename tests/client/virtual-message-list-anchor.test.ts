// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'

import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'

const messages = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}` }))

describe('VirtualMessageList anchor navigation', () => {
  let frameQueue: FrameRequestCallback[] = []

  beforeEach(() => {
    frameQueue = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameQueue.push(callback)
      return frameQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  function runAnimationFrames(count: number) {
    for (let i = 0; i < count; i++) {
      const callbacks = frameQueue.splice(0)
      callbacks.forEach(callback => callback(performance.now()))
    }
  }

  it('renders a target anchor that starts outside the visible range', async () => {
    const wrapper = mount(VirtualMessageList, {
      attachTo: document.body,
      props: {
        messages,
        estimatedItemHeight: 100,
        overscan: 0,
      },
      slots: {
        item: ({ message }: { message: { id: string } }) => h(
          'article',
          { id: `message-${message.id}` },
          [
            message.id,
            message.id === 'm40' ? h('h2', { id: 'anchor-m40' }, 'Target') : null,
          ],
        ),
      },
    })

    const scroller = wrapper.element as HTMLElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 240 })
    scroller.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 320,
      bottom: 240,
      width: 320,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    expect(document.getElementById('message-m40')).toBeNull()

    wrapper.vm.scrollToAnchor('m40', 'anchor-m40')
    await nextTick()
    await nextTick()

    expect(document.getElementById('message-m40')).not.toBeNull()
    expect(document.getElementById('anchor-m40')).not.toBeNull()

    runAnimationFrames(8)
    await nextTick()

    expect(scroller.scrollTop).toBeGreaterThan(0)
  })
})
