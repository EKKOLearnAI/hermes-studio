import type { Attachment } from '@/stores/hermes/chat'

export interface BrowserAnnotationSubmission {
  file: File
  context: string
}

export function createBrowserAnnotationAttachment(
  submission: BrowserAnnotationSubmission,
): Attachment {
  const file = submission.file
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    type: file.type,
    size: file.size,
    url: URL.createObjectURL(file),
    file,
    ...(submission.context.trim() ? { context: submission.context.trim() } : {}),
  }
}
