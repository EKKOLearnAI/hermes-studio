import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as kanbanApi from '@/api/hermes/kanban'
import type { KanbanTask, KanbanStats, KanbanAssignee, KanbanBoard, KanbanCapabilities, KanbanDiagnosticsOptions, KanbanDispatchOptions, KanbanBulkUpdateRequest } from '@/api/hermes/kanban'

export const KANBAN_SELECTED_BOARD_STORAGE_KEY = 'hermes.kanban.selectedBoard'
export const DEFAULT_KANBAN_BOARD = 'default'

const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function safeStorageGet(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore storage failures; selectedBoard still remains explicit in-memory.
  }
}

export function normalizeBoardSlug(board?: string | null): string {
  const trimmed = board?.trim().toLowerCase()
  if (!trimmed) return DEFAULT_KANBAN_BOARD
  return BOARD_SLUG_RE.test(trimmed) ? trimmed : DEFAULT_KANBAN_BOARD
}

export const useKanbanStore = defineStore('kanban', () => {
  const tasks = ref<KanbanTask[]>([])
  const stats = ref<KanbanStats | null>(null)
  const assignees = ref<KanbanAssignee[]>([])
  const boards = ref<KanbanBoard[]>([])
  const capabilities = ref<KanbanCapabilities | null>(null)
  const loading = ref(false)
  const boardsLoading = ref(false)
  const boardWarning = ref<string | null>(null)

  const selectedBoard = ref(normalizeBoardSlug(safeStorageGet(KANBAN_SELECTED_BOARD_STORAGE_KEY)))

  const filterStatus = ref<string | null>(null)
  const filterAssignee = ref<string | null>(null)

  let boardGeneration = 0
  let boardsRequestSeq = 0
  let tasksRequestSeq = 0
  let statsRequestSeq = 0
  let assigneesRequestSeq = 0
  let loadingRequestSeq = 0
  let eventStreamSeq = 0
  let eventSocket: WebSocket | null = null
  let eventReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let eventStreamEnabled = false

  const activeBoards = computed(() => {
    const visible = boards.value.filter(board => !board.archived)
    if (!visible.some(board => board.slug === DEFAULT_KANBAN_BOARD)) {
      return [{
        slug: DEFAULT_KANBAN_BOARD,
        name: 'Default',
        description: '',
        icon: '',
        color: '',
        created_at: null,
        archived: false,
        counts: {},
        total: 0,
      }, ...visible]
    }
    return visible
  })

  function isCapabilitySupported(key: string): boolean {
    if (!capabilities.value) return false
    const detail = capabilities.value.capabilities?.find(capability => capability.key === key)
    if (detail) return detail.status === 'supported'
    if (capabilities.value.missing?.includes(key)) return false
    return capabilities.value.supports?.[key] === true
  }

  function assertCapability(key: string): void {
    if (!isCapabilitySupported(key)) {
      throw new Error(`Kanban capability "${key}" is not supported by the current Hermes backend`)
    }
  }

  function hasCapabilityStatus(key: string, statuses: Array<'supported' | 'partial' | 'missing'>): boolean {
    const detail = capabilities.value?.capabilities?.find(capability => capability.key === key)
    if (detail) return statuses.includes(detail.status)
    if (statuses.includes('supported')) return isCapabilitySupported(key)
    return false
  }

  function assertCapabilityStatus(key: string, statuses: Array<'supported' | 'partial' | 'missing'>): void {
    if (!hasCapabilityStatus(key, statuses)) {
      throw new Error(`Kanban capability "${key}" is not available with the required status`)
    }
  }

  function boardExists(board: string): boolean {
    return activeBoards.value.some(item => item.slug === board)
  }

  function resolveAvailableBoard(candidate?: string | null): string {
    const normalized = normalizeBoardSlug(candidate)
    if (boards.value.length > 0 && !boardExists(normalized)) return DEFAULT_KANBAN_BOARD
    return normalized
  }

  function clearBoardScopedState() {
    tasks.value = []
    stats.value = null
    assignees.value = []
  }

  function clearEventTimers() {
    if (eventReconnectTimer) clearTimeout(eventReconnectTimer)
    if (eventRefreshTimer) clearTimeout(eventRefreshTimer)
    eventReconnectTimer = null
    eventRefreshTimer = null
  }

  function closeEventSocket() {
    if (!eventSocket) return
    const socket = eventSocket
    eventSocket = null
    socket.onclose = null
    socket.onerror = null
    socket.onmessage = null
    try { socket.close() } catch { }
  }

  function stopEventStream() {
    eventStreamEnabled = false
    eventStreamSeq++
    clearEventTimers()
    closeEventSocket()
  }

  function scheduleEventRefresh(board: string, generation: number, seq: number) {
    if (eventRefreshTimer) clearTimeout(eventRefreshTimer)
    eventRefreshTimer = setTimeout(() => {
      if (!eventStreamEnabled || seq !== eventStreamSeq || generation !== boardGeneration || board !== selectedBoard.value) return
      void Promise.all([fetchBoards(), fetchTasks(true), fetchStats(), fetchAssignees()])
    }, 100)
  }

  function scheduleEventReconnect(board: string, generation: number, seq: number) {
    if (eventReconnectTimer) clearTimeout(eventReconnectTimer)
    eventReconnectTimer = setTimeout(() => {
      if (!eventStreamEnabled || seq !== eventStreamSeq || generation !== boardGeneration || board !== selectedBoard.value) return
      connectEventStream(board, generation, seq)
    }, 3000)
  }

  function connectEventStream(board: string, generation: number, seq: number) {
    closeEventSocket()
    let socket: WebSocket
    try {
      socket = kanbanApi.openKanbanEventStream({ board })
    } catch (err) {
      console.error('Failed to open kanban event stream:', err)
      scheduleEventReconnect(board, generation, seq)
      return
    }
    eventSocket = socket
    socket.onmessage = (event) => {
      if (!eventStreamEnabled || seq !== eventStreamSeq || generation !== boardGeneration || board !== selectedBoard.value) return
      try {
        const payload = JSON.parse(String(event.data))
        if (payload?.type === 'event') scheduleEventRefresh(board, generation, seq)
      } catch {
        scheduleEventRefresh(board, generation, seq)
      }
    }
    socket.onerror = () => {
      if (eventSocket === socket) console.error('Kanban event stream error')
    }
    socket.onclose = () => {
      if (eventSocket === socket) {
        eventSocket = null
        scheduleEventReconnect(board, generation, seq)
      }
    }
  }

  function hasEventStreamCapability(): boolean {
    const status = capabilities.value?.capabilities?.find(capability => capability.key === 'events')?.status
    return status === 'supported' || status === 'partial' || isCapabilitySupported('events')
  }

  function startEventStream() {
    if (!hasEventStreamCapability()) return false
    eventStreamEnabled = true
    const seq = ++eventStreamSeq
    const generation = boardGeneration
    const board = selectedBoard.value
    clearEventTimers()
    connectEventStream(board, generation, seq)
    return true
  }

  function restartEventStreamIfActive() {
    if (eventStreamEnabled) startEventStream()
  }

  function setSelectedBoard(board?: string | null): string {
    const resolved = resolveAvailableBoard(board)
    const changed = selectedBoard.value !== resolved
    selectedBoard.value = resolved
    safeStorageSet(KANBAN_SELECTED_BOARD_STORAGE_KEY, resolved)
    boardWarning.value = null
    if (changed) {
      clearBoardScopedState()
      boardGeneration++
      restartEventStreamIfActive()
    }
    return resolved
  }

  function recoverSelectedBoard(candidate?: string | null): { board: string; recovered: boolean } {
    const normalized = normalizeBoardSlug(candidate)
    const resolved = resolveAvailableBoard(normalized)
    const recovered = resolved !== normalized
    setSelectedBoard(resolved)
    if (recovered) {
      boardWarning.value = `Board "${normalized}" is unavailable; fell back to "${resolved}".`
    }
    return { board: resolved, recovered }
  }

  function nextRequestContext(nextSeq: () => number) {
    const seq = nextSeq()
    const generation = boardGeneration
    const board = selectedBoard.value
    return { seq, generation, board }
  }

  function isCurrentRequest(seq: number, generation: number, board: string, currentSeq: number): boolean {
    return seq === currentSeq && generation === boardGeneration && board === selectedBoard.value
  }

  async function fetchBoards(includeArchived = false) {
    const seq = ++boardsRequestSeq
    boardsLoading.value = true
    try {
      const nextBoards = await kanbanApi.listBoards({ includeArchived })
      if (seq !== boardsRequestSeq) return
      boards.value = nextBoards
      const resolved = resolveAvailableBoard(selectedBoard.value)
      if (resolved !== selectedBoard.value) recoverSelectedBoard(selectedBoard.value)
    } catch (err) {
      if (seq === boardsRequestSeq) console.error('Failed to fetch kanban boards:', err)
    } finally {
      if (seq === boardsRequestSeq) boardsLoading.value = false
    }
  }

  async function fetchCapabilities() {
    try {
      capabilities.value = await kanbanApi.getCapabilities()
    } catch (err) {
      console.error('Failed to fetch kanban capabilities:', err)
    }
  }

  async function createBoard(data: { slug: string; name?: string; description?: string; icon?: string; color?: string; switchCurrent?: boolean }) {
    const board = await kanbanApi.createBoard(data)
    await fetchBoards()
    setSelectedBoard(board.slug)
    await refreshAll()
    return board
  }

  async function archiveSelectedBoard() {
    const board = selectedBoard.value
    if (board === DEFAULT_KANBAN_BOARD) throw new Error('Cannot archive the default kanban board')
    await kanbanApi.archiveBoard(board)
    await fetchBoards()
    setSelectedBoard(DEFAULT_KANBAN_BOARD)
    await refreshAll()
  }

  async function fetchTasks(silent = false) {
    const { seq, generation, board } = nextRequestContext(() => ++tasksRequestSeq)
    const loadingSeq = silent ? 0 : ++loadingRequestSeq
    if (!silent) loading.value = true
    try {
      const nextTasks = await kanbanApi.listTasks({
        board,
        status: filterStatus.value || undefined,
        assignee: filterAssignee.value || undefined,
        includeArchived: true,
      })
      if (isCurrentRequest(seq, generation, board, tasksRequestSeq)) tasks.value = nextTasks
    } catch (err) {
      if (isCurrentRequest(seq, generation, board, tasksRequestSeq)) console.error('Failed to fetch kanban tasks:', err)
    } finally {
      if (!silent && loadingSeq === loadingRequestSeq) loading.value = false
    }
  }

  async function fetchStats() {
    const { seq, generation, board } = nextRequestContext(() => ++statsRequestSeq)
    try {
      const nextStats = await kanbanApi.getStats({ board })
      if (isCurrentRequest(seq, generation, board, statsRequestSeq)) stats.value = nextStats
    } catch (err) {
      if (isCurrentRequest(seq, generation, board, statsRequestSeq)) console.error('Failed to fetch kanban stats:', err)
    }
  }

  async function fetchAssignees() {
    const { seq, generation, board } = nextRequestContext(() => ++assigneesRequestSeq)
    try {
      const nextAssignees = await kanbanApi.getAssignees({ board })
      if (isCurrentRequest(seq, generation, board, assigneesRequestSeq)) assignees.value = nextAssignees
    } catch (err) {
      if (isCurrentRequest(seq, generation, board, assigneesRequestSeq)) console.error('Failed to fetch kanban assignees:', err)
    }
  }

  async function createTask(data: { title: string; body?: string; assignee?: string; priority?: number; tenant?: string }) {
    const board = selectedBoard.value
    const task = await kanbanApi.createTask(data, { board })
    if (board === selectedBoard.value) {
      tasks.value.unshift(task)
      await Promise.all([fetchStats(), fetchBoards()])
    }
    return task
  }

  async function completeTasks(taskIds: string[], summary?: string) {
    const board = selectedBoard.value
    await kanbanApi.completeTasks(taskIds, summary, { board })
    if (board === selectedBoard.value) {
      for (const id of taskIds) {
        const task = tasks.value.find(t => t.id === id)
        if (task) task.status = 'done'
      }
      await Promise.all([fetchStats(), fetchBoards()])
    }
  }

  async function blockTask(taskId: string, reason: string) {
    const board = selectedBoard.value
    await kanbanApi.blockTask(taskId, reason, { board })
    if (board === selectedBoard.value) {
      const task = tasks.value.find(t => t.id === taskId)
      if (task) task.status = 'blocked'
      await Promise.all([fetchStats(), fetchBoards()])
    }
  }

  async function unblockTasks(taskIds: string[]) {
    const board = selectedBoard.value
    await kanbanApi.unblockTasks(taskIds, { board })
    if (board === selectedBoard.value) {
      for (const id of taskIds) {
        const task = tasks.value.find(t => t.id === id)
        if (task) task.status = 'ready'
      }
      await Promise.all([fetchStats(), fetchBoards()])
    }
  }

  async function assignTask(taskId: string, profile: string) {
    const board = selectedBoard.value
    await kanbanApi.assignTask(taskId, profile, { board })
    if (board === selectedBoard.value) {
      const task = tasks.value.find(t => t.id === taskId)
      if (task) task.assignee = profile
      await Promise.all([fetchStats(), fetchAssignees()])
    }
  }

  async function addComment(taskId: string, body: string, author?: string) {
    assertCapability('commentsWrite')
    return kanbanApi.addComment(taskId, { body, author }, { board: selectedBoard.value })
  }

  async function linkTasks(parentId: string, childId: string) {
    assertCapability('links')
    const board = selectedBoard.value
    const result = await kanbanApi.linkTasks({ parent_id: parentId, child_id: childId }, { board })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards()])
    return result
  }

  async function unlinkTasks(parentId: string, childId: string) {
    assertCapability('links')
    const board = selectedBoard.value
    const result = await kanbanApi.unlinkTasks({ parent_id: parentId, child_id: childId }, { board })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards()])
    return result
  }

  async function bulkUpdateTasks(data: Omit<KanbanBulkUpdateRequest, 'ids'> & { ids: string[] }) {
    assertCapabilityStatus('bulk', ['supported', 'partial'])
    const board = selectedBoard.value
    const result = await kanbanApi.bulkUpdateTasks(data, { board })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards(), fetchAssignees()])
    return result
  }

  async function getTaskLog(taskId: string, tail?: number) {
    assertCapability('taskLog')
    return kanbanApi.getTaskLog(taskId, { board: selectedBoard.value, tail })
  }

  async function getDiagnostics(opts: Omit<KanbanDiagnosticsOptions, 'board'> = {}) {
    assertCapability('diagnostics')
    return kanbanApi.getDiagnostics({ ...opts, board: selectedBoard.value })
  }

  async function reclaimTask(taskId: string, reason?: string) {
    assertCapability('reclaim')
    const board = selectedBoard.value
    const result = await kanbanApi.reclaimTask(taskId, { board, reason })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards()])
    return result
  }

  async function reassignTask(taskId: string, profile: string, opts: { reclaim?: boolean; reason?: string } = {}) {
    assertCapability('reassign')
    const board = selectedBoard.value
    const result = await kanbanApi.reassignTask(taskId, profile, { board, ...opts })
    if (board === selectedBoard.value) {
      const task = tasks.value.find(t => t.id === taskId)
      if (task) task.assignee = profile === 'none' ? null : profile
      await Promise.all([fetchStats(), fetchAssignees()])
    }
    return result
  }

  async function specifyTask(taskId: string, author?: string) {
    assertCapability('specify')
    const board = selectedBoard.value
    const result = await kanbanApi.specifyTask(taskId, { board, author })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards()])
    return result
  }

  async function dispatch(opts: Omit<KanbanDispatchOptions, 'board'> = {}) {
    assertCapability('dispatch')
    const board = selectedBoard.value
    const result = await kanbanApi.dispatch({ ...opts, board })
    if (board === selectedBoard.value) await Promise.all([fetchTasks(true), fetchStats(), fetchBoards()])
    return result
  }

  function setFilter(key: 'status' | 'assignee', value: string | null) {
    if (key === 'status') filterStatus.value = value
    else filterAssignee.value = value
  }

  async function refreshAll() {
    await Promise.all([fetchBoards(), fetchTasks(), fetchStats(), fetchAssignees()])
  }

  return {
    tasks,
    stats,
    assignees,
    boards,
    capabilities,
    activeBoards,
    isCapabilitySupported,
    loading,
    boardsLoading,
    boardWarning,
    selectedBoard,
    filterStatus,
    filterAssignee,
    fetchBoards,
    fetchCapabilities,
    fetchTasks,
    fetchStats,
    fetchAssignees,
    createTask,
    createBoard,
    archiveSelectedBoard,
    completeTasks,
    blockTask,
    unblockTasks,
    assignTask,
    addComment,
    linkTasks,
    unlinkTasks,
    bulkUpdateTasks,
    getTaskLog,
    getDiagnostics,
    reclaimTask,
    reassignTask,
    specifyTask,
    dispatch,
    setFilter,
    setSelectedBoard,
    startEventStream,
    stopEventStream,
    recoverSelectedBoard,
    resolveAvailableBoard,
    clearBoardScopedState,
    refreshAll,
  }
})
