<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight'
import { downloadFile } from '@/api/hermes/download'

const props = defineProps<{ content: string }>()
const { t } = useI18n()
const message = useMessage()

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    return renderHighlightedCodeBlock(str, lang, t('common.copy'))
  },
})

const renderedHtml = computed(() => md.render(props.content))

function handleMarkdownClick(event: MouseEvent): void {
  void handleCodeBlockCopyClick(event)

  // Handle file path link clicks for download
  const target = event.target as HTMLElement
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
  <div class="markdown-body" v-html="renderedHtml" @click="handleMarkdownClick"></div>
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
</style>
