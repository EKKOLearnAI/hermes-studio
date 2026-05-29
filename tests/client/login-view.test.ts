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

describe('LoginView password login', () => {
  beforeEach(() => {
    delete (window as any).__LOGIN_TOKEN__
    vi.clearAllMocks()
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: true, username: 'admin' })
  })

  it('logs in with username and password', async () => {
    mockLoginWithPassword.mockResolvedValue('jwt-token')
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockLoginWithPassword).toHaveBeenCalledWith('admin', '123456')
    expect(mockSetApiKey).toHaveBeenCalledWith('jwt-token')
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('shows the default login hint', () => {
    const wrapper = mount(LoginView)

    expect(wrapper.text()).toContain('login.defaultCredentialsHint')
  })

  it('shows an error when password login fails', async () => {
    mockLoginWithPassword.mockRejectedValue(new Error('Invalid username or password'))
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('bad-password')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('Invalid username or password')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows the reset command hint when the login IP is locked', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('admin')
    await inputs[1].setValue('123456')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('login.tooManyAttempts')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.lockResetHint')
    expect(wrapper.find('.login-lock-hint').text()).toContain('login.defaultLoginResetHint')
    const commands = wrapper.findAll('.login-lock-hint code').map(command => command.text())
    expect(commands).toEqual([
      'hermes-web-ui clear-login-locks --restart',
      'hermes-web-ui reset-default-login',
    ])
  })
})
