<script setup lang="ts">
import { computed } from 'vue'

type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context'

const props = defineProps<{
  diff: string
  spec?: string
  uiMock?: string
  code?: string
  componentPath?: string
}>()

function classifyLine(text: string): DiffLineKind {
  if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) {
    return 'meta'
  }
  if (text.startsWith('@@')) return 'hunk'
  if (text.startsWith('+')) return 'add'
  if (text.startsWith('-')) return 'remove'
  return 'context'
}

const lines = computed(() =>
  props.diff.split('\n').map((text, index) => ({
    id: `${index}-${text.slice(0, 12)}`,
    number: index + 1,
    text,
    kind: classifyLine(text),
  })),
)
</script>

<template>
  <section class="patch-preview" aria-label="Patch preview">
    <header class="patch-preview-header">
      <span class="patch-preview-title">PatchPreview</span>
      <span class="patch-preview-badge">{{ componentPath || 'read-only diff' }}</span>
    </header>

    <div v-if="spec || uiMock" class="patch-brief">
      <article v-if="spec">
        <span>Spec</span>
        <p>{{ spec }}</p>
      </article>
      <article v-if="uiMock">
        <span>UI Mock</span>
        <p>{{ uiMock }}</p>
      </article>
    </div>

    <div class="patch-preview-body">
      <div
        v-for="line in lines"
        :key="line.id"
        class="diff-line"
        :class="`is-${line.kind}`"
      >
        <span class="diff-line-number">{{ line.number }}</span>
        <code>{{ line.text || ' ' }}</code>
      </div>
    </div>

    <details v-if="code" class="generated-code">
      <summary>Generated Vue SFC</summary>
      <pre>{{ code }}</pre>
    </details>
  </section>
</template>

<style scoped lang="scss">
.patch-preview {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(76, 98, 131, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
}

.patch-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(76, 98, 131, 0.12);
  color: rgba(21, 32, 51, 0.68);
}

.patch-preview-title {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patch-preview-badge {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid rgba(43, 209, 255, 0.24);
  border-radius: 999px;
  color: #137ea1;
  background: rgba(43, 209, 255, 0.08);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.1;
}

.patch-preview-body {
  max-height: 230px;
  overflow: auto;
  padding: 6px 0;
  background: rgba(248, 251, 255, 0.58);
}

.patch-brief {
  display: grid;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid rgba(76, 98, 131, 0.12);
  background: rgba(255, 255, 255, 0.42);
}

.patch-brief article {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.46);
}

.patch-brief span,
.generated-code summary {
  display: block;
  color: rgba(21, 32, 51, 0.5);
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.patch-brief p {
  margin: 5px 0 0;
  color: rgba(21, 32, 51, 0.72);
  font-size: 12px;
  line-height: 1.45;
}

.generated-code {
  border-top: 1px solid rgba(76, 98, 131, 0.12);
  background: rgba(248, 251, 255, 0.58);
}

.generated-code summary {
  padding: 9px 12px;
  cursor: pointer;
}

.generated-code pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: 10px 12px;
  border-top: 1px solid rgba(76, 98, 131, 0.1);
  color: rgba(21, 32, 51, 0.74);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.diff-line {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  min-height: 21px;
  color: rgba(21, 32, 51, 0.72);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.diff-line-number {
  padding: 2px 9px 2px 0;
  color: rgba(86, 105, 132, 0.44);
  text-align: right;
  user-select: none;
}

.diff-line code {
  min-width: 0;
  padding: 2px 10px 2px 8px;
  color: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diff-line.is-add {
  color: #176c42;
  background: rgba(32, 178, 111, 0.1);
}

.diff-line.is-remove {
  color: #9f2d2d;
  background: rgba(248, 113, 113, 0.09);
}

.diff-line.is-hunk {
  color: #116b8b;
  background: rgba(43, 209, 255, 0.11);
}

.diff-line.is-meta {
  color: rgba(21, 32, 51, 0.52);
  background: rgba(76, 98, 131, 0.06);
}

:global(.dark) .patch-preview {
  border-color: rgba(255, 255, 255, 0.11);
  background: rgba(22, 27, 38, 0.68);
}

:global(.dark) .patch-preview-header {
  border-bottom-color: rgba(255, 255, 255, 0.09);
  color: rgba(237, 243, 255, 0.72);
}

:global(.dark) .patch-preview-body {
  background: rgba(9, 13, 22, 0.44);
}

:global(.dark) .patch-brief,
:global(.dark) .generated-code {
  border-color: rgba(255, 255, 255, 0.09);
  background: rgba(9, 13, 22, 0.34);
}

:global(.dark) .patch-brief article {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
}

:global(.dark) .patch-brief span,
:global(.dark) .generated-code summary,
:global(.dark) .generated-code pre {
  color: rgba(237, 243, 255, 0.62);
}

:global(.dark) .patch-brief p {
  color: rgba(237, 243, 255, 0.76);
}

:global(.dark) .diff-line {
  color: rgba(237, 243, 255, 0.76);
}

:global(.dark) .diff-line-number {
  color: rgba(237, 243, 255, 0.34);
}

:global(.dark) .diff-line.is-add {
  color: #a7f3d0;
  background: rgba(32, 178, 111, 0.13);
}

:global(.dark) .diff-line.is-remove {
  color: #fecaca;
  background: rgba(248, 113, 113, 0.12);
}

:global(.dark) .diff-line.is-hunk {
  color: #9de9ff;
}

:global(.dark) .diff-line.is-meta {
  color: rgba(237, 243, 255, 0.5);
}
</style>
