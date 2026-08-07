// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
}))
const routerPush = vi.hoisted(() => vi.fn())
const toastCreate = vi.hoisted(() => vi.fn(() => ({ destroy: vi.fn() })))
const socketApi = vi.hoisted(() => ({ onNotificationCreated: vi.fn(() => vi.fn()), disconnectNotificationSocket: vi.fn() }))

vi.mock('@/api/hermes/notifications', () => api)
vi.mock('@/api/hermes/notification-socket', () => socketApi)
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  useRouter: () => ({ push: routerPush }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<any>('naive-ui')),
  useNotification: () => ({ create: toastCreate }),
}))

import NotificationCenter from '@/components/layout/NotificationCenter.vue'

const notices = [
  {
    id: 'n-1', type: 'chat.completed', severity: 'success', title: 'Research finished',
    body: 'The answer is ready', unread: true, createdAt: 100, updatedAt: 100,
    source: { kind: 'session', id: 's-1', route: { name: 'hermes.session', params: { sessionId: 's-1' } } },
  },
  {
    id: 'n-2', type: 'workflow.failed', severity: 'error', title: 'Workflow failed',
    body: 'Review the failed node', unread: false, createdAt: 90, updatedAt: 90,
    source: { kind: 'workflow', id: 'wf-1', route: { name: 'hermes.workflow', query: { workflowId: 'wf-1' } } },
  },
]

function mountCenter() {
  return mount(NotificationCenter, {
    global: {
      plugins: [createPinia()],
      stubs: {
        NButton: { props: ['disabled'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
        NSpin: { template: '<div><slot /></div>' },
      },
    },
  })
}

describe('NotificationCenter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
    api.fetchNotifications.mockResolvedValue({ notifications: notices, unreadCount: 1 })
    api.markNotificationRead.mockResolvedValue({ notification: { ...notices[0], unread: false } })
    api.markAllNotificationsRead.mockResolvedValue({ updated: 1 })
    api.deleteNotification.mockResolvedValue({ deleted: true })
  })

  afterEach(() => vi.useRealTimers())

  it('shows an unread badge and durable notification list', async () => {
    const wrapper = mountCenter()
    await flushPromises()

    expect(wrapper.get('[data-testid="notification-bell"]').text()).toContain('1')
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    expect(wrapper.text()).toContain('Research finished')
    expect(wrapper.text()).toContain('Workflow failed')
  })

  it('marks a notification read before navigating to its source', async () => {
    const wrapper = mountCenter()
    await flushPromises()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await wrapper.get('[data-testid="notification-item-n-1"]').trigger('click')
    await flushPromises()

    expect(api.markNotificationRead).toHaveBeenCalledWith('n-1')
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.session', params: { sessionId: 's-1' } })
    expect(wrapper.get('[data-testid="notification-bell"]').text()).not.toContain('1')
  })

  it('marks all read and deletes one without navigating', async () => {
    const wrapper = mountCenter()
    await flushPromises()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await wrapper.get('[data-testid="notification-read-all"]').trigger('click')
    await wrapper.get('[data-testid="notification-delete-n-2"]').trigger('click')
    await flushPromises()

    expect(api.markAllNotificationsRead).toHaveBeenCalled()
    expect(api.deleteNotification).toHaveBeenCalledWith('n-2')
    expect(routerPush).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Workflow failed')
  })

  it('shows retryable error and empty states', async () => {
    api.fetchNotifications.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountCenter()
    await flushPromises()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    expect(wrapper.text()).toContain('notifications.loadFailed')

    api.fetchNotifications.mockResolvedValueOnce({ notifications: [], unreadCount: 0 })
    await wrapper.get('[data-testid="notification-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('notifications.empty')
  })
})
