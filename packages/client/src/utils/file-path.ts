import type { FileEntry } from '@/api/hermes/files'

export function getClipboardPathForEntry(entry: FileEntry): string {
  return entry.absolutePath || entry.path
}
