import { describe, expect, it } from 'vitest'
import {
  GROUP_CHAT_AGENT_LINK_FRAME,
  groupChatAgentLinkPopupResponse,
  isGroupChatAgentLinkPopup,
} from '../../packages/desktop/src/main/group-chat-agent-popup'

describe('desktop group chat Agent authorization popup', () => {
  it('allows the dedicated local and remote Agent link route', () => {
    expect(isGroupChatAgentLinkPopup(
      'http://127.0.0.1:8748/?groupChatAgentLink=1#/group-chat-link?parentOrigin=https%3A%2F%2Fchat.example.com&state=abc',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(true)
    expect(isGroupChatAgentLinkPopup(
      'https://agent.example.com/?groupChatAgentLink=1#/group-chat-link?parentOrigin=https%3A%2F%2Fchat.example.com&state=abc',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(true)
  })

  it('rejects lookalike routes, credentials, schemes, and frame names', () => {
    expect(isGroupChatAgentLinkPopup(
      'https://agent.example.com/#/group-chat-link-evil',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(false)
    expect(isGroupChatAgentLinkPopup(
      'https://agent.example.com/?unexpected=1#/group-chat-link',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(false)
    expect(isGroupChatAgentLinkPopup(
      'https://agent.example.com/other?groupChatAgentLink=1#/group-chat-link',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(false)
    expect(isGroupChatAgentLinkPopup(
      'https://user:pass@agent.example.com/#/group-chat-link',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(false)
    expect(isGroupChatAgentLinkPopup(
      'file:///tmp/index.html#/group-chat-link',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )).toBe(false)
    expect(isGroupChatAgentLinkPopup(
      'https://agent.example.com/#/group-chat-link',
      'unexpected-popup',
    )).toBe(false)
  })

  it('uses a sandboxed renderer without the desktop preload', () => {
    const response = groupChatAgentLinkPopupResponse(
      'https://agent.example.com/?groupChatAgentLink=1#/group-chat-link',
      GROUP_CHAT_AGENT_LINK_FRAME,
    )

    expect(response?.action).toBe('allow')
    expect(response?.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
    expect(response?.overrideBrowserWindowOptions?.webPreferences).not.toHaveProperty('preload')
  })
})
