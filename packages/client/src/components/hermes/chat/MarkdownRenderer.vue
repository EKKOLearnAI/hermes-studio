<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { downloadFile } from '@/api/hermes/download'

const props = defineProps<{ content: string }>()
const { t } = useI18n()
const message = useMessage()

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs-code-block"><div class="code-header"><span class="code-lang">${lang}</span><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.hljs-code-block').querySelector('code').textContent)">${t('common.copy')}</button></div><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // fall through
      }
    }
    return `<pre class="hljs-code-block"><div class="code-header"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.hljs-code-block').querySelector('code').textContent)">${t('common.copy')}</button></div><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`
  },
})

const renderedHtml = computed(() => md.render(props.content))

/**
 * Intercept clicks on file path links inside rendered markdown.
 * - http(s) links: open in new tab (default browser behavior)
 * - File path links (starting with /): trigger download via API
 */
function handleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('a') as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // Let http(s) links behave normally
  if (href.startsWith('http://') || href.startsWith('https://')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return
  }

  // File path links: intercept and download
  if (href.startsWith('/')) {
    e.preventDefault()
    e.stopPropagation()
    const linkText = link.textContent || ''
    // Parse filename from "File: xxx" pattern or use link text
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    downloadFile(href, fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}
</script>

<template>
  <div class="markdown-body" v-html="renderedHtml" @click="handleClick"></div>
</template>

<style lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  font-size: 14px;
  line-height: 1.65;
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
}

.hljs-code-block {
  margin: 8px 0;
  border-radius: $radius-sm;
  overflow: hidden;
  background: $code-bg;
  border: 1px solid $border-color;

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: rgba(0, 0, 0, 0.03);
    border-bottom: 1px solid $border-color;

    .code-lang {
      font-size: 11px;
      color: $text-muted;
      text-transform: uppercase;
    }

    .copy-btn {
      font-size: 11px;
      color: $text-muted;
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      transition: all $transition-fast;

      &:hover {
        color: $text-primary;
        background: rgba(0, 0, 0, 0.05);
      }
    }
  }

  code.hljs {
    display: block;
    padding: 12px;
    font-family: $font-code;
    font-size: 13px;
    line-height: 1.5;
    overflow-x: auto;
  }
}

// highlight.js theme override — pure ink B&W
.hljs {
  color: #2a2a2a;
  background: none;
}

.hljs-keyword,
.hljs-selector-tag { color: #1a1a1a; font-weight: 600; }
.hljs-string,
.hljs-attr { color: #555555; }
.hljs-number { color: #333333; }
.hljs-comment { color: #999999; font-style: italic; }
.hljs-built_in { color: #444444; }
.hljs-type { color: #3a3a3a; }
.hljs-variable { color: #1a1a1a; }
.hljs-title,
.hljs-title\.function_ { color: #1a1a1a; }
.hljs-params { color: #2a2a2a; }
.hljs-meta { color: #999999; }

// Dark mode highlight.js — inverted pure ink
.dark .hljs { color: #d0d0d0; }
.dark .hljs-keyword,
.dark .hljs-selector-tag { color: #f0f0f0; font-weight: 600; }
.dark .hljs-string,
.dark .hljs-attr { color: #aaaaaa; }
.dark .hljs-number { color: #cccccc; }
.dark .hljs-comment { color: #666666; font-style: italic; }
.dark .hljs-built_in { color: #bbbbbb; }
.dark .hljs-type { color: #c6c6c6; }
.dark .hljs-variable { color: #f0f0f0; }
.dark .hljs-title,
.dark .hljs-title\.function_ { color: #f0f0f0; }
.dark .hljs-params { color: #d0d0d0; }
.dark .hljs-meta { color: #666666; }
</style>
