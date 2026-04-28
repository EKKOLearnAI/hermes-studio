// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockReplace = vi.hoisted(() => vi.fn())
const mockFetchAuthStatus = vi.hoisted(() => vi.fn())
const mockLoginWithPassword = vi.hoisted(() => vi.fn())
const mockSetApiKey = vi.hoisted(() => vi.fn())
const mockHasApiKey = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/client', () => ({
  setApiKey: mockSetApiKey,
  hasApiKey: mockHasApiKey,
}))

vi.mock('@/api/auth', () => ({
  fetchAuthStatus: mockFetchAuthStatus,
  loginWithPassword: mockLoginWithPassword,
}))

import LoginView from '@/views/LoginView.vue'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('LoginView token login', () => {
  beforeEach(() => {
    delete (window as any).__LOGIN_TOKEN__
    vi.clearAllMocks()
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: false })
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('validates token login against the Hermes sessions endpoint', async () => {
    const wrapper = mount(LoginView)

    await wrapper.find('input.login-input').setValue('secret-token')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledWith('/api/hermes/sessions', {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(mockSetApiKey).toHaveBeenCalledWith('secret-token')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('keeps the existing invalid-token behavior on 401', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 })
    const wrapper = mount(LoginView)

    await wrapper.find('input.login-input').setValue('bad-token')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockFetch).toHaveBeenCalledWith('/api/hermes/sessions', {
      headers: { Authorization: 'Bearer bad-token' },
    })
    expect(wrapper.find('.login-error').text()).toBe('login.invalidToken')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
