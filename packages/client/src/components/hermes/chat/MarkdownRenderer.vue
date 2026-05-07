<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type MarkdownIt from 'markdown-it'
import MarkdownItConstructor from 'markdown-it'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight'
import { repairNestedMarkdownFences } from './markdownFenceRepair'
import {
  MERMAID_MAX_DIAGRAMS_PER_MESSAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  decodeMermaidSource,
  isMermaidFence,
  renderMermaidPlaceholder,
} from './mermaidRenderer'
import { downloadFile, getDownloadUrl } from '@/api/hermes/download'

const props = withDefaults(defineProps<{
    content: string
    mentionNames?: string[]
}>(), {
    mentionNames: () => [],
})

const { t } = useI18n()
const message = useMessage()

const md: MarkdownIt = new MarkdownItConstructor({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    return renderHighlightedCodeBlock(str, lang, t('common.copy'))
  },
})

const defaultFenceRenderer = md.renderer.rules.fence?.bind(md.renderer.rules)

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (isMermaidFence(token.info)) {
    return renderMermaidPlaceholder(token.content)
  }

  if (defaultFenceRenderer) {
    return defaultFenceRenderer(tokens, idx, options, env, self)
  }

  return self.renderToken(tokens, idx, options)
}

const markdownBody = ref<HTMLElement | null>(null)
const componentId = `hermes-mermaid-${Math.random().toString(36).slice(2)}`
const previewUrl = ref<string | null>(null)
let renderGeneration = 0
let unmounted = false

const renderedHtml = computed(() => {
  let html = md.render(repairNestedMarkdownFences(props.content))

  // Replace image src paths with download URLs
  // Replace both src="/path" and src='/path' formats
  html = html.replace(/src="\/([^"]+)"/g, (_match, path) => {
    const originalPath = '/' + path
    const downloadUrl = getDownloadUrl(originalPath)
    return `src="${downloadUrl}"`
  })

  html = html.replace(/src='\/([^']+)'/g, (_match, path) => {
    const originalPath = '/' + path
    const downloadUrl = getDownloadUrl(originalPath)
    return `src='${downloadUrl}'`
  })

  // Replace local file links with file card UI or video player
  // Match <a href="/tmp/file.pdf">filename</a> or <a href="/tmp/video.mp4">filename</a>
  html = html.replace(/<a href="(\/[^"]+)">([^<]+)<\/a>/g, (match, path, filename) => {
    // Only replace local file paths (starting with /)
    if (!path.startsWith('/')) return match

    const fileName = filename.trim()
    const ext = path.split('.').pop()?.toLowerCase()

    // Video files: render as video player
    if (ext === 'mp4' || ext === 'webm') {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-video-container">
        <video class="markdown-video" controls preload="metadata" src="${downloadUrl}"></video>
        <div class="markdown-video-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span class="att-name">${fileName}</span>
        </div>
      </div>`
    }

    // Other files: render as file card
    return `<div class="markdown-file-card" data-path="${path}" data-filename="${fileName}" title="${t('download.downloadFile')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span class="att-name">${fileName}</span>
      <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </div>`
  })

  if (props.mentionNames && props.mentionNames.length > 0) {
    const escaped = props.mentionNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const re = new RegExp(`(?<=[\\s>]|^)@(${escaped.join('|')})(?=\\s|$)`, 'gi')
    html = html.replace(re, '<span class="mention-highlight">@$1</span>')
  }
  return html
})

function renderMermaidFallback(element: HTMLElement, source: string): void {
  element.outerHTML = renderHighlightedCodeBlock(source, 'mermaid', t('common.copy'))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const { overflow, overflowY } = getComputedStyle(current)
    if (overflow === 'auto' || overflow === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

function cleanupMermaidRenderArtifacts(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
}

async function renderMermaidDiagrams(): Promise<void> {
  const generation = ++renderGeneration
  await nextTick()

  const root = markdownBody.value
  if (unmounted || generation !== renderGeneration || !root) return

  const pendingDiagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-pending="true"]'))
  if (pendingDiagrams.length === 0) return

  const diagramsToRender = pendingDiagrams.slice(0, MERMAID_MAX_DIAGRAMS_PER_MESSAGE)
  const diagramsToFallback = pendingDiagrams.slice(MERMAID_MAX_DIAGRAMS_PER_MESSAGE)

  for (const element of diagramsToFallback) {
    renderMermaidFallback(element, decodeMermaidSource(element.getAttribute('data-mermaid-source')))
  }

  const renderCandidates = diagramsToRender
    .map(element => ({
      element,
      source: decodeMermaidSource(element.getAttribute('data-mermaid-source')),
    }))

  const validDiagrams = [] as typeof renderCandidates
  for (const candidate of renderCandidates) {
    if (unmounted || generation !== renderGeneration || !root.contains(candidate.element)) return

    if (!candidate.source || candidate.source.length > MERMAID_MAX_SOURCE_LENGTH) {
      renderMermaidFallback(candidate.element, candidate.source)
      continue
    }

    validDiagrams.push(candidate)
  }

  if (validDiagrams.length === 0) return

  let mermaid: typeof import('mermaid').default

  try {
    mermaid = (await withTimeout(import('mermaid'), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid import')).default
    if (unmounted || generation !== renderGeneration) return

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
    })
  } catch {
    if (unmounted || generation !== renderGeneration) return
    for (const { element, source } of validDiagrams) {
      if (root.contains(element)) {
        renderMermaidFallback(element, source)
      }
    }
    return
  }

  for (const [index, { element, source }] of validDiagrams.entries()) {
    if (unmounted || generation !== renderGeneration || !root.contains(element)) return

    try {
      const id = `${componentId}-${generation}-${index}`
      const result = await withTimeout(mermaid.render(id, source), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid render')
      cleanupMermaidRenderArtifacts(id)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return

      element.removeAttribute('data-mermaid-pending')
      element.removeAttribute('data-mermaid-source')
      element.innerHTML = result.svg
      // After mermaid renders, scroll the nearest scrollable ancestor to bottom
      nextTick(() => {
        const scrollParent = getScrollParent(markdownBody.value)
        if (scrollParent) {
          scrollParent.scrollTop = scrollParent.scrollHeight
        }
      })
    } catch {
      cleanupMermaidRenderArtifacts(`${componentId}-${generation}-${index}`)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return
      renderMermaidFallback(element, source)
    }
  }
}

onMounted(() => {
  void renderMermaidDiagrams()
})

watch(renderedHtml, () => {
  void renderMermaidDiagrams()
}, { flush: 'post' })

onBeforeUnmount(() => {
  unmounted = true
  renderGeneration += 1
})

async function handleMarkdownClick(event: MouseEvent): Promise<void> {
  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult !== null) {
    if (copyResult) {
      message.success(t('common.copied'))
    } else {
      message.error(t('chat.copyFailed'))
    }
    return
  }

  const target = event.target as HTMLElement

  // Handle image clicks for preview
  const img = target.closest('img') as HTMLImageElement | null
  if (img) {
    event.preventDefault()
    previewUrl.value = img.src
    return
  }

  // Handle file card clicks for download
  const fileCard = target.closest('.markdown-file-card') as HTMLElement | null
  if (fileCard) {
    event.preventDefault()
    event.stopPropagation()
    const path = fileCard.getAttribute('data-path')
    const fileName = fileCard.getAttribute('data-filename')
    if (path) {
      message.info(t('download.downloading'))
      downloadFile(path, fileName || undefined).catch((err: Error) => {
        message.error(err.message || t('download.downloadFailed'))
      })
    }
    return
  }

  // Handle file path link clicks for download
  const link = target.closest('a') as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // Let http(s) links behave normally — use window.open to prevent
  // the hash-based router from intercepting the click
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }

  // Full download URL: open directly (already has /api/hermes/download?path=...)
  if (href.startsWith('/api/hermes/download?')) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    // Parse the real file path from the existing query param
    const url = new URL(href, window.location.origin)
    const realPath = url.searchParams.get('path') || href
    downloadFile(realPath, fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
    return
  }

  // File path links: intercept and download
  if (href.startsWith('/')) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    downloadFile(href, fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}
</script>

<template>
  <div ref="markdownBody" class="markdown-body" v-html="renderedHtml" @click="handleMarkdownClick"></div>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  font-size: 14px;
  line-height: 1.65;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: auto;

  p {
    margin: 0 0 8px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  ul, ol {
    padding-left: 20px;
    margin: 4px 0 8px;
  }

  li {
    margin: 2px 0;
  }

  strong {
    color: $text-primary;
    font-weight: 600;
  }

  em {
    color: $text-secondary;
  }

  a {
    color: $accent-primary;
    text-decoration: underline;
    text-underline-offset: 2px;

    &:hover {
      color: $accent-hover;
    }
  }

  img {
    display: block;
    max-width: 200px;
    max-height: 160px;
    object-fit: contain;
    cursor: pointer;
    border-radius: 4px;
    margin: 8px 0;
  }

  .markdown-video-container {
    margin: 12px 0;
    border-radius: $radius-sm;
    overflow: hidden;
    background: #000;
    border: 1px solid $border-color;
  }

  .markdown-video {
    display: block;
    width: 100%;
    max-width: 640px;
    max-height: 480px;
    object-fit: contain;
  }

  .markdown-video-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: 12px;

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-file-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: $text-secondary;
    background-color: rgba(0, 0, 0, 0.04);
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    margin: 8px 0;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover {
      background-color: rgba(0, 0, 0, 0.08);
      border-color: $border-color;
    }

    .att-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .att-download-icon {
      flex-shrink: 0;
      opacity: 0.6;
      transition: opacity 0.15s ease;
    }

    &:hover .att-download-icon {
      opacity: 1;
    }
  }

  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-left: 3px solid $border-color;
    color: $text-secondary;
  }

  code:not(.hljs) {
    background: $code-bg;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: $font-code;
    font-size: 13px;
    color: $accent-primary;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    overflow-x: auto;

    th, td {
      padding: 6px 12px;
      border: 1px solid $border-color;
      text-align: left;
      font-size: 13px;
    }

    th {
      background: rgba(var(--accent-primary-rgb), 0.08);
      color: $text-primary;
      font-weight: 600;
    }

    td {
      color: $text-secondary;
    }
  }

  hr {
    border: none;
    border-top: 1px solid $border-color;
    margin: 12px 0;
  }

  .mermaid-diagram {
    margin: 10px 0;
    padding: 14px;
    border: 1px solid $border-color;
    border-radius: 8px;
    background: rgba(var(--accent-primary-rgb), 0.04);
    overflow-x: auto;

    svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
  }

  .mermaid-loading {
    color: $text-secondary;
    font-size: 13px;
    font-family: $font-code;
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  cursor: pointer;
}
</style>
