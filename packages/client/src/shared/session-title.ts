export interface SessionTitleMessage {
  role?: string
  content?: string
  attachments?: Array<{ name?: string }>
}

export function normalizeTitleText(input: unknown): string {
  return String(input || '').replace(/\s+/g, ' ').trim()
}

export function titleSourceTextFromUserMessage(message: SessionTitleMessage | null | undefined): string {
  if (!message) return ''
  const attachmentTitle = Array.isArray(message.attachments) && message.attachments.length > 0
    ? message.attachments.map(item => normalizeTitleText(item?.name)).filter(Boolean).join(', ')
    : ''
  return normalizeTitleText(attachmentTitle || message.content)
}

export function firstMeaningfulUserMessage(messages: SessionTitleMessage[]): SessionTitleMessage | null {
  return messages.find(message => message?.role === 'user' && !!titleSourceTextFromUserMessage(message)) || null
}

export function buildStandardSessionTitleFromText(text: string): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized
}

export function buildStandardSessionTitle(messages: SessionTitleMessage[]): string {
  return buildStandardSessionTitleFromText(titleSourceTextFromUserMessage(firstMeaningfulUserMessage(messages)))
}
