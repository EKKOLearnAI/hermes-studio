// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

import PlatformCard from '@/components/hermes/settings/PlatformCard.vue'

function mountCard(credentials: Record<string, any>) {
  return mount(PlatformCard, {
    props: {
      platformKey: 'matrix',
      name: 'Matrix',
      icon: '<svg></svg>',
      config: {},
      credentials,
    },
    global: {
      stubs: {
        NTag: {
          props: ['type'],
          template: '<span class="tag" :data-type="type"><slot /></span>',
        },
        NAlert: {
          template: '<div><slot /></div>',
        },
      },
    },
  })
}

describe('PlatformCard', () => {
  it('treats Matrix password login as configured only with homeserver, user id, and password', () => {
    expect(mountCard({
      extra: {
        homeserver: 'https://matrix.example.org',
        user_id: '@hermes:example.org',
        password: 'secret',
      },
    }).find('.platform-card').classes()).toContain('configured')

    expect(mountCard({
      extra: {
        homeserver: 'https://matrix.example.org',
        password: 'secret',
      },
    }).find('.platform-card').classes()).not.toContain('configured')
  })

  it('treats Matrix access-token login as configured with a homeserver and token', () => {
    expect(mountCard({
      token: 'syt_token',
      extra: {
        homeserver: 'https://matrix.example.org',
      },
    }).find('.platform-card').classes()).toContain('configured')

    expect(mountCard({
      token: 'syt_token',
      extra: {},
    }).find('.platform-card').classes()).not.toContain('configured')
  })
})
