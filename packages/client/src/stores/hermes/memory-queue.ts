import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type CandidateMemorySource = 'Chat' | 'File Analysis' | 'Tool Proposal' | 'Manual'
export type CandidateMemoryStatus = 'pending' | 'saved'

export interface CandidateMemory {
  id: string
  content: string
  source: CandidateMemorySource | string
  confidenceScore: number
  timestamp: number
  status: CandidateMemoryStatus
  savedAt?: number
  markdownFrontmatter?: string
}

export interface ProposeMemoryPayload {
  content: string
  source?: CandidateMemorySource | string
  confidenceScore?: number
}

function makeId(): string {
  return `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clampConfidence(score: number | undefined): number {
  if (typeof score !== 'number' || Number.isNaN(score)) return 75
  return Math.max(0, Math.min(100, Math.round(score)))
}

function formatDate(timestamp = Date.now()): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildMemoryFrontmatter(memory: Pick<CandidateMemory, 'source' | 'confidenceScore'>, timestamp = Date.now()): string {
  return [
    '---',
    `date: ${formatDate(timestamp)}`,
    `source: ${memory.source}`,
    'tags: [aurora, extracted-memory]',
    `confidence: ${memory.confidenceScore}%`,
    '---',
  ].join('\n')
}

export const useMemoryQueueStore = defineStore('memory-queue', () => {
  const candidateMemories = ref<CandidateMemory[]>([])
  const isReviewQueueOpen = ref(false)

  const pendingMemories = computed(() =>
    candidateMemories.value.filter(memory => memory.status === 'pending'),
  )
  const savedMemories = computed(() =>
    candidateMemories.value.filter(memory => memory.status === 'saved'),
  )
  const pendingCount = computed(() => pendingMemories.value.length)

  function proposeMemory(payload: ProposeMemoryPayload): CandidateMemory {
    const content = payload.content.trim()
    if (!content) throw new Error('Candidate memory content is empty.')

    const memory: CandidateMemory = {
      id: makeId(),
      content,
      source: payload.source || 'Chat',
      confidenceScore: clampConfidence(payload.confidenceScore),
      timestamp: Date.now(),
      status: 'pending',
    }

    candidateMemories.value.unshift(memory)
    isReviewQueueOpen.value = true
    return memory
  }

  function updateMemory(id: string, content: string) {
    const memory = candidateMemories.value.find(item => item.id === id)
    if (!memory || memory.status !== 'pending') return
    memory.content = content.trim()
  }

  function approveMemory(id: string): string | null {
    const memory = candidateMemories.value.find(item => item.id === id)
    if (!memory || memory.status !== 'pending') return null
    const savedAt = Date.now()
    const frontmatter = buildMemoryFrontmatter(memory, savedAt)
    memory.status = 'saved'
    memory.savedAt = savedAt
    memory.markdownFrontmatter = frontmatter
    return frontmatter
  }

  function discardMemory(id: string) {
    candidateMemories.value = candidateMemories.value.filter(memory => memory.id !== id)
  }

  function openReviewQueue() {
    isReviewQueueOpen.value = true
  }

  function closeReviewQueue() {
    isReviewQueueOpen.value = false
  }

  function toggleReviewQueue() {
    isReviewQueueOpen.value = !isReviewQueueOpen.value
  }

  return {
    candidateMemories,
    pendingMemories,
    savedMemories,
    pendingCount,
    isReviewQueueOpen,
    proposeMemory,
    updateMemory,
    approveMemory,
    discardMemory,
    openReviewQueue,
    closeReviewQueue,
    toggleReviewQueue,
  }
})
