// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import OutlinePanel from '@/components/hermes/chat/OutlinePanel.vue'

/**
 * A conversation carries whatever language the person and the agent write in,
 * which is not the language the interface is set to. Anything showing their
 * words has to take its direction from the words; labels the interface owns
 * must not, or they would flip whenever the conversation does.
 */
describe('chat text direction follows the conversation, not the interface', () => {
  it('lets an outline entry take its direction from the message it quotes', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'راجع تقرير التغطية وأضف اليوم الثاني', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '## الخلاصة\n\nتم التحديث.', createdAt: 2 },
    ]
    const wrapper = mount(OutlinePanel, { props: { messages: messages as any } })

    const question = wrapper.find('.q-text')
    expect(question.exists()).toBe(true)
    expect(question.attributes('dir')).toBe('auto')

    const heading = wrapper.find('.heading-text')
    if (heading.exists()) expect(heading.attributes('dir')).toBe('auto')

    // The interface's own label is not a conversation and stays put.
    expect(wrapper.find('.outline-title').attributes('dir')).toBeUndefined()
  })

  // ChatPanel and SessionSearchModal are asserted against source, the way
  // tests/client/chat-panel-session-click.test.ts already does — mounting
  // either one drags in the whole chat surface.
  it('marks the session title in the chat header', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    expect(source).toContain('<span class="header-session-title" dir="auto">{{ headerTitle }}</span>')
  })

  it('marks the title and snippet of a search result', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/SessionSearchModal.vue', 'utf8')
    expect(source).toContain('<span class="result-title" dir="auto">')
    expect(source).toContain('<div class="result-snippet" dir="auto">')
    // The static headline above the results belongs to the interface.
    expect(source).toContain('<div class="search-title">')
  })

  it('marks the goal a subagent was given', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/SubagentStreamPanel.vue', 'utf8')
    expect(source).toContain('<div class="subagent-stream-title" dir="auto">')
  })
})
