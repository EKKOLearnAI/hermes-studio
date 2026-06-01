<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, useNotification } from 'naive-ui'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import type { CandidateMemory } from '@/stores/hermes/memory-queue'

const memoryQueueStore = useMemoryQueueStore()
const notification = useNotification()
const editingId = ref<string | null>(null)
const editingContent = ref('')

const pendingMemories = computed(() => memoryQueueStore.pendingMemories)
const savedMemories = computed(() => memoryQueueStore.savedMemories.slice(0, 4))

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function startEdit(memory: CandidateMemory) {
  editingId.value = memory.id
  editingContent.value = memory.content
}

function cancelEdit() {
  editingId.value = null
  editingContent.value = ''
}

function saveEdit(memory: CandidateMemory) {
  const content = editingContent.value.trim()
  if (!content) return
  memoryQueueStore.updateMemory(memory.id, content)
  cancelEdit()
}

function approve(memory: CandidateMemory) {
  if (editingId.value === memory.id) saveEdit(memory)
  const frontmatter = memoryQueueStore.approveMemory(memory.id)
  if (!frontmatter) return
  notification.success({
    title: 'Obsidian Markdown Draft',
    content: frontmatter,
    duration: 6500,
    keepAliveOnHover: true,
  })
}

function discard(memory: CandidateMemory) {
  memoryQueueStore.discardMemory(memory.id)
  if (editingId.value === memory.id) cancelEdit()
}
</script>

<template>
  <Transition name="memory-review">
    <aside
      v-if="memoryQueueStore.isReviewQueueOpen"
      class="memory-review-queue"
      aria-label="Memory Review Queue"
      aria-live="polite"
    >
      <header class="memory-review-header">
        <div>
          <p class="memory-review-kicker">Memory Governance</p>
          <h2>Review Queue</h2>
        </div>

        <NButton
          quaternary
          size="tiny"
          @click="memoryQueueStore.closeReviewQueue"
        >
          Close
        </NButton>
      </header>

      <section class="memory-review-body">
        <div class="memory-review-summary">
          <strong>{{ pendingMemories.length }}</strong>
          <span>candidate memories awaiting human approval</span>
        </div>

        <div v-if="pendingMemories.length === 0" class="memory-empty">
          No pending candidate memories.
        </div>

        <article
          v-for="memory in pendingMemories"
          :key="memory.id"
          class="memory-card"
        >
          <div class="memory-card-meta">
            <span>{{ memory.source }}</span>
            <strong>{{ memory.confidenceScore }}%</strong>
          </div>

          <NInput
            v-if="editingId === memory.id"
            v-model:value="editingContent"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            class="memory-edit-input"
          />
          <p v-else class="memory-content">{{ memory.content }}</p>

          <div class="memory-card-footer">
            <span>{{ formatTime(memory.timestamp) }}</span>
            <div class="memory-card-actions">
              <template v-if="editingId === memory.id">
                <NButton size="tiny" secondary @click="cancelEdit">
                  Cancel
                </NButton>
                <NButton size="tiny" type="primary" @click="saveEdit(memory)">
                  Save Edit
                </NButton>
              </template>
              <template v-else>
                <NButton size="tiny" secondary @click="startEdit(memory)">
                  Edit
                </NButton>
                <NButton size="tiny" secondary type="error" @click="discard(memory)">
                  Discard
                </NButton>
                <NButton size="tiny" type="success" @click="approve(memory)">
                  Approve
                </NButton>
              </template>
            </div>
          </div>
        </article>

        <section v-if="savedMemories.length" class="memory-saved-section">
          <h3>Saved Mock</h3>
          <article
            v-for="memory in savedMemories"
            :key="memory.id"
            class="memory-card saved"
          >
            <div class="memory-card-meta">
              <span>{{ memory.source }}</span>
              <strong>saved</strong>
            </div>
            <p class="memory-content">{{ memory.content }}</p>
            <pre v-if="memory.markdownFrontmatter">{{ memory.markdownFrontmatter }}</pre>
          </article>
        </section>
      </section>
    </aside>
  </Transition>
</template>

<style scoped lang="scss">
.memory-review-queue {
  position: fixed;
  top: 68px;
  right: 18px;
  z-index: 1700;
  display: flex;
  width: min(430px, calc(100vw - 36px));
  max-height: calc(100vh - 88px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--aurora-glass-border, rgba(255, 255, 255, 0.62));
  border-radius: 16px;
  color: var(--aurora-text, #172033);
  background: var(--aurora-glass-bg, rgba(255, 255, 255, 0.76));
  box-shadow: var(--aurora-glass-shadow, 0 22px 70px rgba(66, 84, 117, 0.22));
  backdrop-filter: blur(24px);
}

.memory-review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 60px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid rgba(92, 113, 148, 0.14);
}

.memory-review-kicker {
  margin: 0 0 4px;
  color: rgba(21, 32, 51, 0.52);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.memory-review-header h2 {
  margin: 0;
  color: #142033;
  font-size: 16px;
  font-weight: 850;
  line-height: 1.2;
}

.memory-review-body {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding: 12px;
}

.memory-review-summary {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid rgba(43, 209, 255, 0.18);
  border-radius: 8px;
  color: rgba(21, 32, 51, 0.64);
  background: rgba(43, 209, 255, 0.08);
  font-size: 12px;
  line-height: 1.35;
}

.memory-review-summary strong {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 999px;
  color: #117da0;
  background: rgba(43, 209, 255, 0.14);
  font-size: 13px;
}

.memory-empty {
  padding: 20px 10px;
  color: rgba(21, 32, 51, 0.52);
  text-align: center;
  font-size: 13px;
}

.memory-card {
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.52);
}

.memory-card.saved {
  opacity: 0.82;
  background: rgba(52, 211, 153, 0.08);
}

.memory-card-meta,
.memory-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.memory-card-meta {
  color: rgba(21, 32, 51, 0.48);
  font-size: 11px;
  font-weight: 800;
}

.memory-card-meta strong {
  padding: 4px 7px;
  border-radius: 999px;
  color: #16724b;
  background: rgba(52, 211, 153, 0.12);
  font-size: 10px;
  line-height: 1.1;
}

.memory-content {
  margin: 10px 0 0;
  color: rgba(21, 32, 51, 0.74);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.memory-edit-input {
  margin-top: 10px;
}

.memory-card-footer {
  align-items: flex-end;
  margin-top: 12px;
  color: rgba(21, 32, 51, 0.44);
  font-size: 11px;
}

.memory-card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.memory-saved-section {
  display: grid;
  gap: 8px;
  margin-top: 6px;
}

.memory-saved-section h3 {
  margin: 0;
  color: rgba(21, 32, 51, 0.58);
  font-size: 11px;
  font-weight: 850;
  text-transform: uppercase;
}

.memory-card pre {
  margin: 10px 0 0;
  max-height: 140px;
  overflow: auto;
  padding: 10px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 8px;
  color: rgba(21, 32, 51, 0.68);
  background: rgba(255, 255, 255, 0.44);
  white-space: pre-wrap;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}

.memory-review-enter-active,
.memory-review-leave-active {
  transition: all var(--aurora-ease, 0.3s cubic-bezier(0.2, 0, 0, 1));
}

.memory-review-enter-from,
.memory-review-leave-to {
  opacity: 0;
  transform: translate(12px, 8px);
}

:global(.dark) .memory-review-queue {
  border-color: rgba(255, 255, 255, 0.12);
  color: #edf3ff;
  background:
    linear-gradient(135deg, rgba(29, 35, 48, 0.92), rgba(17, 21, 31, 0.78)),
    rgba(18, 22, 32, 0.8);
  box-shadow:
    0 22px 70px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .memory-review-header {
  border-color: rgba(255, 255, 255, 0.09);
}

:global(.dark) .memory-review-header h2 {
  color: #edf3ff;
}

:global(.dark) .memory-review-kicker,
:global(.dark) .memory-empty,
:global(.dark) .memory-card-meta,
:global(.dark) .memory-card-footer,
:global(.dark) .memory-content,
:global(.dark) .memory-card pre {
  color: rgba(237, 243, 255, 0.64);
}

:global(.dark) .memory-card,
:global(.dark) .memory-card pre {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

@media (max-width: 560px) {
  .memory-review-queue {
    top: 60px;
    right: 10px;
    width: calc(100vw - 20px);
    max-height: calc(100vh - 70px);
  }

  .memory-card-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .memory-card-actions {
    justify-content: stretch;
  }
}
</style>
