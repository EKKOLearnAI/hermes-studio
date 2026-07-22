interface PendingBrowserAttachment {
  file: File
  context?: string
  expiresAt: number
}

const ATTACHMENT_TTL_MS = 5 * 60 * 1000
const pendingAttachments: PendingBrowserAttachment[] = []

function discardExpired(now = Date.now()): void {
  for (let index = pendingAttachments.length - 1; index >= 0; index -= 1) {
    if (pendingAttachments[index].expiresAt <= now) pendingAttachments.splice(index, 1)
  }
}

export function queueBrowserAttachment(file: File, context?: string): void {
  discardExpired()
  pendingAttachments.push({
    file,
    ...(context?.trim() ? { context: context.trim() } : {}),
    expiresAt: Date.now() + ATTACHMENT_TTL_MS,
  })
}

export function takeBrowserAttachments(): { files: File[]; context: string[] } {
  discardExpired()
  const attachments = pendingAttachments.splice(0, pendingAttachments.length)
  return {
    files: attachments.map(item => item.file),
    context: attachments.flatMap(item => item.context ? [item.context] : []),
  }
}
