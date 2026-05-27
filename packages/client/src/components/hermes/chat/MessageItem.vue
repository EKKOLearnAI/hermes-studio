// Escape markdown reference link definitions ([text]: url) for safe rendering.
// Reference links are rendered as invisible content by markdown-it.
function escapeRefLinks(text: string): string {
  return text.replace(/^(\s*\[[^\]]*\]:\s*)/gm, '\\$1')
}

const escapedDisplayText = computed(() => escapeRefLinks(displayText.value))