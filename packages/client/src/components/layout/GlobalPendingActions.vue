<script setup lang="ts">
import { h, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { NButton, NInput, useMessage, useNotification, type NotificationReactive } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useChatStore, type PendingApproval } from '@/stores/hermes/chat'
import { useGroupChatStore, type GroupPendingApproval } from '@/stores/hermes/group-chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { playCompletionSound } from '@/utils/completion-sound'
import { approveWorkflowNode, type WorkflowRecord } from '@/api/hermes/workflows'
import { listWorkflowsSocket, onWorkflowStatusUpdated, subscribeWorkflowStatuses, disconnectWorkflowSocket, type WorkflowRuntimeStatus } from '@/api/hermes/workflow-socket'

const chatStore = useChatStore()
const groupChatStore = useGroupChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const notification = useNotification()
const message = useMessage()
const { t } = useI18n()
const route = useRoute()

const handles = new Map<string, NotificationReactive>()
const announcedKeys = new Set<string>()
const clarifyDrafts = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const workflows = ref<WorkflowRecord[]>([])
const workflowStatuses = reactive<Record<string, WorkflowRuntimeStatus>>({})
let stopWorkflowStatus: (() => void) | null = null
let workflowSubscriptionGeneration = 0
let pendingBaselineEstablished = false
let approvalSoundArmed = false

function resetWorkflowSubscriptions(profile?: string | null) {
  const generation = ++workflowSubscriptionGeneration
  stopWorkflowStatus?.()
  stopWorkflowStatus = onWorkflowStatusUpdated(status => {
    if (generation === workflowSubscriptionGeneration) workflowStatuses[status.workflowId] = status
  }, profile)
  workflows.value = []
  for (const key of Object.keys(workflowStatuses)) delete workflowStatuses[key]
  void listWorkflowsSocket(profile).then(records => {
    if (generation === workflowSubscriptionGeneration) workflows.value = records
  }).catch(() => undefined)
  void subscribeWorkflowStatuses(undefined, profile).then(statuses => {
    if (generation !== workflowSubscriptionGeneration) return
    for (const status of statuses) {
      if (status.runId) {
        for (const { nodeId, executionId } of status.pendingApprovals || []) {
          announcedKeys.add(`workflow-approval:${status.workflowId}:${status.runId}:${nodeId}:${executionId || ''}`)
        }
      }
      workflowStatuses[status.workflowId] = status
    }
  }).catch(() => undefined)
}

type ApprovalChoice = PendingApproval['choices'][number]
type GlobalPendingAction =
  | { key: string; kind: 'chat-approval'; title: string; pending: PendingApproval }
  | { key: string; kind: 'chat-clarify'; title: string; pending: { sessionId: string; clarifyId: string; question: string; choices: string[] | null } }
  | { key: string; kind: 'group-approval'; title: string; pending: GroupPendingApproval }
  | { key: string; kind: 'workflow-approval'; title: string; workflowId: string; runId: string; nodeId: string; executionId?: string }

function sessionTitle(sessionId: string): string {
  return chatStore.sessions.find(session => session.id === sessionId)?.title || sessionId
}

function roomTitle(roomId: string): string {
  return groupChatStore.rooms.find(room => room.id === roomId)?.name || roomId
}

function pendingActions(): GlobalPendingAction[] {
  const actions: GlobalPendingAction[] = []
  const visibleChatSessionId = ['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'].includes(String(route.name || ''))
    ? chatStore.activeSessionId
    : null
  const visibleGroupRoomId = route.name === 'hermes.groupChatRoom' ? groupChatStore.currentRoomId : null
  for (const pending of chatStore.pendingApprovals.values()) {
    if (pending.sessionId === visibleChatSessionId) continue
    actions.push({ key: `chat-approval:${pending.sessionId}:${pending.approvalId}`, kind: 'chat-approval', title: sessionTitle(pending.sessionId), pending })
  }
  for (const pending of chatStore.pendingClarifies.values()) {
    if (pending.sessionId === visibleChatSessionId) continue
    actions.push({ key: `chat-clarify:${pending.sessionId}:${pending.clarifyId}`, kind: 'chat-clarify', title: sessionTitle(pending.sessionId), pending })
  }
  for (const pending of groupChatStore.pendingApprovals.values()) {
    if (pending.roomId === visibleGroupRoomId) continue
    actions.push({ key: `group-approval:${pending.roomId}:${pending.approvalId}`, kind: 'group-approval', title: roomTitle(pending.roomId), pending })
  }
  for (const status of Object.values(workflowStatuses)) {
    if (!status.runId) continue
    for (const { nodeId, executionId } of status.pendingApprovals || []) {
      actions.push({
        key: `workflow-approval:${status.workflowId}:${status.runId}:${nodeId}:${executionId || ''}`,
        kind: 'workflow-approval',
        title: workflows.value.find(workflow => workflow.id === status.workflowId)?.name || status.workflowId,
        workflowId: status.workflowId,
        runId: status.runId,
        nodeId,
        executionId,
      })
    }
  }
  return actions
}

function approvalButtons(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>) {
  const pending = action.pending
  const choices: ApprovalChoice[] = pending.isMemoryWrite ? ['once', 'deny'] : pending.choices
  const labels: Record<ApprovalChoice, string> = {
    once: pending.isMemoryWrite ? t('chat.approvalAgree') : t('chat.approvalAllowOnce'),
    session: t('chat.approvalAllowSession'),
    always: t('chat.approvalAlways'),
    deny: t('chat.approvalDeny'),
  }
  return h('div', { class: 'global-pending-actions' }, choices.map(choice => h(NButton, {
    size: 'small',
    type: choice === 'deny' ? 'error' : choice === 'once' ? 'primary' : 'default',
    secondary: choice !== 'once',
    loading: submitting[action.key],
    onClick: () => void submitApproval(action, choice),
  }, { default: () => labels[choice] })))
}

async function submitApproval(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>, choice: ApprovalChoice) {
  if (submitting[action.key]) return
  submitting[action.key] = true
  try {
    if (action.kind === 'chat-approval') chatStore.respondApprovalFor(action.pending.sessionId, action.pending.approvalId, choice)
    else await groupChatStore.respondApprovalFor(action.pending.roomId, action.pending.approvalId, choice)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

function clarifyContent(action: Extract<GlobalPendingAction, { kind: 'chat-clarify' }>) {
  return h('div', { class: 'global-clarify-content' }, [
    h('div', { class: 'global-clarify-question' }, action.pending.question),
    action.pending.choices?.length
      ? h('div', { class: 'global-clarify-choices' }, action.pending.choices.map(choice => h(NButton, {
          size: 'small', secondary: clarifyDrafts[action.key] !== choice,
          type: clarifyDrafts[action.key] === choice ? 'primary' : 'default',
          onClick: () => { clarifyDrafts[action.key] = choice },
        }, { default: () => choice })))
      : null,
    h(NInput, {
      value: clarifyDrafts[action.key] || '',
      placeholder: t('chat.clarifyPlaceholder'),
      'onUpdate:value': (value: string) => { clarifyDrafts[action.key] = value },
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void submitClarify(action)
        }
      },
    }),
  ])
}

async function submitClarify(action: Extract<GlobalPendingAction, { kind: 'chat-clarify' }>) {
  const response = (clarifyDrafts[action.key] || '').trim()
  if (!response || submitting[action.key]) return
  submitting[action.key] = true
  try {
    chatStore.respondToClarifyFor(action.pending.sessionId, action.pending.clarifyId, response)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

async function submitWorkflowApproval(action: Extract<GlobalPendingAction, { kind: 'workflow-approval' }>, approved: boolean) {
  if (submitting[action.key]) return
  submitting[action.key] = true
  try {
    await approveWorkflowNode(action.workflowId, action.runId, action.nodeId, approved, action.executionId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

function createGlobalNotification(action: GlobalPendingAction): NotificationReactive {
  const clarify = action.kind === 'chat-clarify'
  return notification.create({
    title: `${action.title} · ${clarify ? t('chat.clarifyTitle') : t('chat.approvalTitle')}`,
    content: clarify
      ? () => clarifyContent(action)
      : action.kind === 'workflow-approval'
        ? () => h('div', { class: 'global-approval-content' }, t('workflow.status.pending_approval'))
        : () => h('div', { class: 'global-approval-content' }, [
            h('div', action.pending.description || ''),
            action.pending.command ? h('code', action.pending.command) : null,
          ]),
    action: clarify
      ? () => h(NButton, {
          size: 'small', type: 'primary', disabled: !(clarifyDrafts[action.key] || '').trim(),
          loading: submitting[action.key], onClick: () => void submitClarify(action),
        }, { default: () => t('chat.clarifySubmit') })
      : action.kind === 'workflow-approval'
        ? () => h('div', { class: 'global-pending-actions' }, [
            h(NButton, { size: 'small', type: 'error', secondary: true, loading: submitting[action.key], onClick: () => void submitWorkflowApproval(action, false) }, { default: () => t('chat.approvalDeny') }),
            h(NButton, { size: 'small', type: 'primary', loading: submitting[action.key], onClick: () => void submitWorkflowApproval(action, true) }, { default: () => t('common.confirm') }),
          ])
        : () => approvalButtons(action),
    duration: 0,
    closable: true,
    onClose: () => false,
  })
}

watch(pendingActions, actions => {
  const liveKeys = new Set(actions.map(action => action.key))
  const shouldAnnounce = pendingBaselineEstablished
  let hasNewAction = false
  for (const [key, handle] of handles) {
    if (liveKeys.has(key)) continue
    handle.destroy()
    handles.delete(key)
    delete clarifyDrafts[key]
    delete submitting[key]
  }
  for (const action of actions) {
    if (!announcedKeys.has(action.key)) {
      announcedKeys.add(action.key)
      if (shouldAnnounce) hasNewAction = true
    }
    if (handles.has(action.key)) continue
    handles.set(action.key, createGlobalNotification(action))
  }
  pendingBaselineEstablished = true
  if (hasNewAction && approvalSoundArmed && settingsStore.display.approval_bell) void playCompletionSound()
}, { deep: true, immediate: true })

onMounted(() => {
  resetWorkflowSubscriptions(profilesStore.activeProfileName)
  void groupChatStore.connect().catch(() => undefined)
  void settingsStore.fetchSettings().finally(() => { approvalSoundArmed = true })
})

watch(() => profilesStore.activeProfileName, profile => {
  approvalSoundArmed = false
  resetWorkflowSubscriptions(profile)
  void settingsStore.fetchSettings().finally(() => { approvalSoundArmed = true })
})

onUnmounted(() => {
  stopWorkflowStatus?.()
  disconnectWorkflowSocket()
  groupChatStore.disconnect()
  for (const handle of handles.values()) handle.destroy()
  handles.clear()
})
</script>

<template><span class="global-pending-actions-host" aria-hidden="true" /></template>

<style scoped>.global-pending-actions-host { display: none; }</style>
<style>
.global-pending-actions, .global-clarify-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.global-approval-content, .global-clarify-content { display: grid; gap: 10px; max-width: 420px; overflow-wrap: anywhere; }
.global-approval-content code { display: block; padding: 8px; border-radius: 6px; background: var(--n-color-embedded); white-space: pre-wrap; }
.global-clarify-question { font-weight: 600; }
</style>
