// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'

const dynamicScrollToBottomMock = vi.hoisted(() => vi.fn())
const dynamicScrollToPositionMock = vi.hoisted(() => vi.fn())
const dynamicScrollToItemMock = vi.hoisted(() => vi.fn())

vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    name: 'DynamicScroller',
    props: {
      items: { type: Array, default: () => [] },
    },
    emits: ['scroll', 'resize', 'visible'],
    setup(_props, { expose }) {
      expose({
        scrollToBottom: dynamicScrollToBottomMock,
        scrollToPosition: dynamicScrollToPositionMock,
        scrollToItem: dynamicScrollToItemMock,
      })
    },
    template: `
      <div class="virtual-message-list" @scroll="$emit('scroll')">
        <slot name="before" />
        <slot v-for="(item, index) in items" :item="item" :index="index" :active="true" />
        <slot name="after" />
      </div>
    `,
  }),
  DynamicScrollerItem: defineComponent({
    name: 'DynamicScrollerItem',
    props: {
      item: { type: Object, required: true },
      index: { type: Number, required: true },
      active: { type: Boolean, default: true },
    },
    template: '<div class="virtual-row"><slot /></div>',
  }),
}))

import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'

function setScrollerMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  el.scrollTop = metrics.scrollTop
}

describe('VirtualMessageList scroll behavior', () => {
  let rafCallbacks: FrameRequestCallback[]

  beforeEach(() => {
    vi.clearAllMocks()
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => undefined
    })
  })

  it('cancels queued bottom scrolling when the user scrolls away from the bottom', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })

    ;(wrapper.vm as any).scrollToBottom({ frames: 5, keepAliveMs: 700 })
    await nextTick()
    expect(rafCallbacks.length).toBeGreaterThan(0)

    scroller.element.scrollTop = 120
    await scroller.trigger('scroll')
    rafCallbacks.splice(0).forEach(callback => callback(performance.now()))

    expect(dynamicScrollToBottomMock).not.toHaveBeenCalled()
    expect(scroller.element.scrollTop).toBe(120)
  })

  it('locks auto-follow as soon as the user scrolls upward during streaming', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-1' }],
      },
      slots: {
        item: '<div>message</div>',
      },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    })
    await scroller.trigger('scroll')

    scroller.element.scrollTop = 580
    await scroller.trigger('scroll')

    expect((wrapper.vm as any).isNearBottom(100)).toBe(true)
    expect((wrapper.vm as any).shouldAutoFollowBottom(100)).toBe(false)

    scroller.element.scrollTop = 600
    await scroller.trigger('scroll')

    expect((wrapper.vm as any).shouldAutoFollowBottom(100)).toBe(true)
  })
})
