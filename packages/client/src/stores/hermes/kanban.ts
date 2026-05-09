import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as kanbanApi from '@/api/hermes/kanban'
import type { KanbanTask, KanbanStats, KanbanAssignee } from '@/api/hermes/kanban'

export const useKanbanStore = defineStore('kanban', () => {
  const tasks = ref<KanbanTask[]>([])
  const stats = ref<KanbanStats | null>(null)
  const assignees = ref<KanbanAssignee[]>([])
  const loading = ref(false)

  const filterStatus = ref<string | null>(null)
  const filterAssignee = ref<string | null>(null)

  async function fetchTasks(silent = false) {
    if (!silent) loading.value = true
    try {
      tasks.value = await kanbanApi.listTasks({
        status: filterStatus.value || undefined,
        assignee: filterAssignee.value || undefined,
      })
    } catch (err) {
      console.error('Failed to fetch kanban tasks:', err)
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function fetchStats() {
    try {
      stats.value = await kanbanApi.getStats()
    } catch (err) {
      console.error('Failed to fetch kanban stats:', err)
    }
  }

  async function fetchAssignees() {
    try {
      assignees.value = await kanbanApi.getAssignees()
    } catch (err) {
      console.error('Failed to fetch kanban assignees:', err)
    }
  }

  async function createTask(data: { title: string; body?: string; assignee?: string; priority?: number; tenant?: string }) {
    const task = await kanbanApi.createTask(data)
    tasks.value.unshift(task)
    await fetchStats()
    return task
  }

  async function completeTasks(taskIds: string[], summary?: string) {
    await kanbanApi.completeTasks(taskIds, summary)
    for (const id of taskIds) {
      const task = tasks.value.find(t => t.id === id)
      if (task) task.status = 'done'
    }
    await fetchStats()
  }

  async function blockTask(taskId: string, reason: string) {
    await kanbanApi.blockTask(taskId, reason)
    const task = tasks.value.find(t => t.id === taskId)
    if (task) task.status = 'blocked'
    await fetchStats()
  }

  async function unblockTasks(taskIds: string[]) {
    await kanbanApi.unblockTasks(taskIds)
    for (const id of taskIds) {
      const task = tasks.value.find(t => t.id === id)
      if (task) task.status = 'ready'
    }
    await fetchStats()
  }

  async function assignTask(taskId: string, profile: string) {
    await kanbanApi.assignTask(taskId, profile)
    const task = tasks.value.find(t => t.id === taskId)
    if (task) task.assignee = profile
  }

  function setFilter(key: 'status' | 'assignee', value: string | null) {
    if (key === 'status') filterStatus.value = value
    else filterAssignee.value = value
  }

  async function refreshAll() {
    await Promise.all([fetchTasks(), fetchStats(), fetchAssignees()])
  }

  return {
    tasks,
    stats,
    assignees,
    loading,
    filterStatus,
    filterAssignee,
    fetchTasks,
    fetchStats,
    fetchAssignees,
    createTask,
    completeTasks,
    blockTask,
    unblockTasks,
    assignTask,
    setFilter,
    refreshAll,
  }
})
