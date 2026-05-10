<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

const { t, tm, rt } = useI18n()
const route = useRoute()

const pageKey = computed(() => (route.meta.page as string) || 'gettingStarted')
const pageTitle = computed(() => t(`docs.${pageKey.value}.title`))
const pageIntro = computed(() => t(`docs.${pageKey.value}.intro`))

interface DocSection {
  title: string
  content: string
  rows?: string[][]
}

const sections = computed<DocSection[]>(() => {
  const key = pageKey.value
  const meta = tm(`docs.${key}`) as Record<string, any>
  if (!meta) return []

  const result: DocSection[] = []
  const sectionKeys = Object.keys(meta).filter(
    (k) => k !== 'title' && k !== 'intro' && typeof meta[k] === 'object' && meta[k] !== null,
  )

  for (const sk of sectionKeys) {
    const section = meta[sk] as Record<string, any>
    result.push({
      title: rt(section.title || ''),
      content: rt(section.content || ''),
      rows: Array.isArray(section.rows) ? section.rows : undefined,
    })
  }

  return result
})
</script>

<template>
  <div class="doc-content">
    <h1 class="doc-title">{{ pageTitle }}</h1>
    <p v-if="pageIntro" class="doc-intro">{{ pageIntro }}</p>

    <div v-for="(section, i) in sections" :key="i" class="doc-section">
      <h2 class="doc-section-title">{{ section.title }}</h2>
      <p v-if="section.content" class="doc-section-text">{{ section.content }}</p>

      <table v-if="section.rows?.length" class="doc-table">
        <tbody>
          <tr v-for="(row, ri) in section.rows" :key="ri">
            <td class="doc-table-key"><code>{{ row[0] }}</code></td>
            <td>{{ row[1] }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped lang="scss">
.doc-content {
  max-width: 720px;
  width: 100%;
  padding: 40px 32px 80px;

  @media (max-width: $breakpoint-mobile) {
    padding: 24px 16px 60px;
  }
}

.doc-title {
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.doc-intro {
  font-size: 16px;
  line-height: 1.7;
  color: var(--text-secondary);
  margin-bottom: 40px;
}

.doc-section {
  margin-bottom: 36px;
}

.doc-section-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-light);
}

.doc-section-text {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.doc-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;

  tr {
    border-bottom: 1px solid var(--border-light);
  }

  td {
    padding: 10px 12px;
    font-size: 14px;
    color: var(--text-secondary);
    vertical-align: top;
  }

  @media (max-width: $breakpoint-mobile) {
    display: block;

    tr {
      display: block;
      padding: 10px 0;
    }

    td {
      display: block;
      padding: 2px 0;
    }
  }
}

.doc-table-key {
  white-space: nowrap;
  width: 1%;
  font-weight: 500;

  code {
    background: var(--bg-secondary);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 13px;
  }

  @media (max-width: $breakpoint-mobile) {
    white-space: normal;
    width: auto;
    margin-bottom: 4px;
  }
}
</style>
