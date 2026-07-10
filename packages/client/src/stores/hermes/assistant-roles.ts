import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as assistantRolesApi from '@/api/hermes/assistant-roles'
import type {
  AssistantRoleDetail,
  AssistantRoleInput,
  AssistantRolePatch,
  AssistantRoleSummary,
  CloneAssistantRoleInput,
  RoleContextBundle,
  RoleContextOptions,
} from '@/api/hermes/assistant-roles'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useAssistantRolesStore = defineStore('assistant-roles', () => {
  const roles = ref<AssistantRoleSummary[]>([])
  const selectedRoleId = ref<string | null>(null)
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)
  const preview = ref<RoleContextBundle | null>(null)
  const loadError = ref<string | null>(null)
  const saveError = ref<string | null>(null)
  const error = computed(() => saveError.value ?? loadError.value)
  let loadSequence = 0
  let saveSequence = 0
  let previewSequence = 0

  function keepSelection(nextRoles: AssistantRoleSummary[]): void {
    if (!selectedRoleId.value || !nextRoles.some(role => role.id === selectedRoleId.value)) {
      selectedRoleId.value = nextRoles[0]?.id ?? null
    }
  }

  async function fetchRoles(): Promise<AssistantRoleSummary[]> {
    const sequence = ++loadSequence
    activeLoads.value += 1
    loadError.value = null
    try {
      const nextRoles = await assistantRolesApi.fetchAssistantRoles()
      if (sequence === loadSequence) {
        roles.value = nextRoles
        keepSelection(nextRoles)
      }
      return nextRoles
    } catch (cause) {
      if (sequence === loadSequence) loadError.value = errorMessage(cause)
      throw cause
    } finally {
      activeLoads.value -= 1
    }
  }

  async function runSave<T>(operation: () => Promise<T>): Promise<T> {
    const sequence = ++saveSequence
    activeSaves.value += 1
    saveError.value = null
    try {
      return await operation()
    } catch (cause) {
      if (sequence === saveSequence) saveError.value = errorMessage(cause)
      throw cause
    } finally {
      activeSaves.value -= 1
    }
  }

  async function refreshRoleAndList(id: string): Promise<AssistantRoleDetail> {
    const detail = await assistantRolesApi.fetchAssistantRole(id)
    await fetchRoles()
    return detail
  }

  async function createRole(input: AssistantRoleInput) {
    return runSave(async () => {
      const created = await assistantRolesApi.createAssistantRole(input)
      await fetchRoles()
      selectedRoleId.value = created.id
      return created
    })
  }

  async function updateRole(id: string, patch: AssistantRolePatch) {
    return runSave(async () => {
      await assistantRolesApi.updateAssistantRole(id, patch)
      return refreshRoleAndList(id)
    })
  }

  async function deleteRole(id: string): Promise<void> {
    return runSave(async () => {
      await assistantRolesApi.deleteAssistantRole(id)
      await fetchRoles()
    })
  }

  async function cloneRole(id: string, input: CloneAssistantRoleInput) {
    return runSave(async () => {
      const cloned = await assistantRolesApi.cloneAssistantRole(id, input)
      await fetchRoles()
      selectedRoleId.value = cloned.id
      return cloned
    })
  }

  async function updateProfileMapping(id: string, profileName: string | null) {
    return runSave(async () => {
      await assistantRolesApi.updateAssistantRoleProfileMapping(id, profileName)
      return refreshRoleAndList(id)
    })
  }

  async function previewContext(id: string, input: RoleContextOptions): Promise<RoleContextBundle> {
    const sequence = ++previewSequence
    return runSave(async () => {
      if (sequence === previewSequence) preview.value = null
      try {
        const context = await assistantRolesApi.previewAssistantRoleContext(id, input)
        if (sequence === previewSequence) preview.value = context
        return context
      } catch (cause) {
        if (sequence === previewSequence) preview.value = null
        throw cause
      }
    })
  }

  return {
    roles,
    selectedRoleId,
    loading,
    saving,
    preview,
    error,
    fetchRoles,
    createRole,
    updateRole,
    deleteRole,
    cloneRole,
    updateProfileMapping,
    previewContext,
  }
})
