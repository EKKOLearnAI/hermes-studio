// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'
import type { ChatMessage } from '@/api/hermes/group-chat'

function mountToolMessage(message: Partial<ChatMessage>) {
  return mount(GroupMessageItem, {
    props: {
      message: {
        id: 'group-tool',
        roomId: 'room-1',
        senderId: 'agent-1',
        senderName: 'UAT Agent',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        toolName: 'runtime_payload',
        toolStatus: 'done',
        ...message,
      } as ChatMessage,
      agents: [],
      members: [],
      currentUserId: 'user-1',
    },
    global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
  })
}

describe('GroupMessageItem tool details', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
  })

  it('normalizes non-string runtime tool payloads before rendering', async () => {
    const wrapper = mountToolMessage({
      toolArgs: { group: true, values: [1, 2, 3] },
      toolResult: false,
    } as unknown as Partial<ChatMessage>)

    await wrapper.find('.tool-line').trigger('click')

    const blocks = wrapper.findAll('.tool-details .hljs-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.code-lang').text()).toBe('json')
    expect(blocks[0].find('code').text()).toContain('values')
    expect(blocks[1].find('.code-lang').text()).toBe('json')
    expect(blocks[1].find('code').text()).toBe('false')
  })

  it('keeps plain string false payloads as text', async () => {
    const wrapper = mountToolMessage({
      toolResult: 'false',
    })

    await wrapper.find('.tool-line').trigger('click')

    const block = wrapper.find('.tool-details .hljs-code-block')
    expect(block.exists()).toBe(true)
    expect(block.find('.code-lang').text()).toBe('text')
    expect(block.find('code').text()).toBe('false')
  })
})
