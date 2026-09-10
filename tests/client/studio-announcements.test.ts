// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { StudioAnnouncement } from '@/api/studio/announcements'

const api = vi.hoisted(() => ({ fetchStudioAnnouncements: vi.fn() }))
const browser = vi.hoisted(() => ({ openUrlInDesktopBrowser: vi.fn() }))
vi.mock('@/api/studio/announcements', () => api)
vi.mock('@/utils/desktop-browser', () => browser)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('zh-TW') }) }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NCard: { props: ['title'], template: '<section><h1>{{ title }}</h1><slot /><slot name="footer" /></section>' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
}))

import StudioAnnouncementPrompt from '@/components/layout/StudioAnnouncementPrompt.vue'

const latest: StudioAnnouncement = { id: 3, updateTime: 100, title: 'Latest news', content: '<b>Plain text</b>', type: 'info', dismissible: true, actionUrl: null }
const response = (list = [latest, { ...latest, id: 2, title: 'Old news' }]) => ({ ok: true, platform: 'desktop', list })
let wrapper: VueWrapper | undefined
const start = async () => { wrapper = mount(StudioAnnouncementPrompt); await flushPromises(); return wrapper }
const focus = async () => { window.dispatchEvent(new Event('focus')); await flushPromises() }

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.fetchStudioAnnouncements.mockResolvedValue(response())
  browser.openUrlInDesktopBrowser.mockResolvedValue(true)
})
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })

describe('Studio announcement prompt', () => {
  it('shows only the latest, renders content as text, and persists dismissal across mounts', async () => {
    const ui = await start()
    expect(api.fetchStudioAnnouncements).toHaveBeenCalledWith('zh-TW')
    expect(ui.text()).toContain('Latest news')
    expect(ui.text()).not.toContain('Old news')
    expect(ui.find('b').exists()).toBe(false)
    await ui.get('button').trigger('click')
    await focus()
    expect(ui.find('section').exists()).toBe(false)
    ui.unmount()
    await start()
    expect(wrapper!.find('section').exists()).toBe(false)
  })

  it('allows a new announcement and an updated latest version to appear', async () => {
    const ui = await start()
    await ui.get('button').trigger('click')
    api.fetchStudioAnnouncements.mockResolvedValue(response([{ ...latest, updateTime: 200 }]))
    await focus()
    expect(ui.find('section').exists()).toBe(true)
    await ui.get('button').trigger('click')
    api.fetchStudioAnnouncements.mockResolvedValue(response([{ ...latest, id: 4 }]))
    await focus()
    expect(ui.find('section').exists()).toBe(true)
  })

  it('ignores overlapping checks and discards requests resolved after unmount', async () => {
    let resolve!: (value: unknown) => void
    api.fetchStudioAnnouncements.mockReturnValue(new Promise(done => { resolve = done }))
    const ui = await start()
    await focus()
    expect(api.fetchStudioAnnouncements).toHaveBeenCalledTimes(1)
    ui.unmount()
    resolve(response())
    await flushPromises()
    await focus()
    expect(api.fetchStudioAnnouncements).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
  })

  it('recovers from network failure on a foreground check', async () => {
    api.fetchStudioAnnouncements.mockRejectedValueOnce(new Error('offline'))
    const ui = await start()
    expect(ui.find('section').exists()).toBe(false)
    await focus()
    expect(ui.find('section').exists()).toBe(true)
  })

  it('opens a valid action through the existing browser helper', async () => {
    api.fetchStudioAnnouncements.mockResolvedValue(response([{ ...latest, actionUrl: 'https://example.com/news' }]))
    const ui = await start()
    expect(ui.findAll('button')).toHaveLength(2)
    await ui.findAll('button')[1].trigger('click')
    await flushPromises()
    expect(browser.openUrlInDesktopBrowser).toHaveBeenCalledWith('https://example.com/news')
    expect(ui.find('section').exists()).toBe(false)
  })

  it('rejects unsafe action URLs and still allows acknowledgement', async () => {
    api.fetchStudioAnnouncements.mockResolvedValue(response([{ ...latest, actionUrl: 'javascript:alert(1)' }]))
    const ui = await start()
    expect(ui.findAll('button')).toHaveLength(1)
    await ui.get('button').trigger('click')
    expect(browser.openUrlInDesktopBrowser).not.toHaveBeenCalled()
  })

  it('keeps dismissal in memory if local storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    const ui = await start()
    await ui.get('button').trigger('click')
    await focus()
    expect(ui.find('section').exists()).toBe(false)
  })
})
