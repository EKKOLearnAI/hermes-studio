import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as configApi from '@/api/hermes/config'
import type { DisplayConfig, AgentConfig, MemoryConfig, SessionResetConfig, PrivacyConfig, ApprovalConfig } from '@/api/hermes/config'

export const useSettingsStore = defineStore('settings', () => {
  const loading = ref(false)
  const saving = ref(false)

  const display = ref<DisplayConfig>({})
  const agent = ref<AgentConfig>({})
  const memory = ref<MemoryConfig>({})
  const sessionReset = ref<SessionResetConfig>({})
  const privacy = ref<PrivacyConfig>({})
  const approvals = ref<ApprovalConfig>({})
  const telegram = ref<Record<string, any>>({})
  const discord = ref<Record<string, any>>({})
  const slack = ref<Record<string, any>>({})
  const whatsapp = ref<Record<string, any>>({})
  const matrix = ref<Record<string, any>>({})
  const wecom = ref<Record<string, any>>({})
  const feishu = ref<Record<string, any>>({})
  const dingtalk = ref<Record<string, any>>({})
  const qqbot = ref<Record<string, any>>({})
  const weixin = ref<Record<string, any>>({})
  const platforms = ref<Record<string, any>>({})

  async function fetchSettings() {
    loading.value = true
    try {
      const data = await configApi.fetchConfig()
      display.value = data.display || {}
      agent.value = data.agent || {}
      memory.value = data.memory || {}
      sessionReset.value = data.session_reset || {}
      privacy.value = data.privacy || {}
      approvals.value = data.approvals || {}
      telegram.value = data.telegram || {}
      discord.value = data.discord || {}
      slack.value = data.slack || {}
      whatsapp.value = data.whatsapp || {}
      matrix.value = data.matrix || {}
      wecom.value = data.wecom || {}
      feishu.value = data.feishu || {}
      dingtalk.value = data.dingtalk || {}
      qqbot.value = data.qqbot || {}
      weixin.value = data.weixin || {}
      platforms.value = data.platforms || {}
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      loading.value = false
    }
  }

  function updateLocal(section: string, values: Record<string, any>) {
    switch (section) {
      case 'display': display.value = { ...display.value, ...values }; break
      case 'agent': agent.value = { ...agent.value, ...values }; break
      case 'memory': memory.value = { ...memory.value, ...values }; break
      case 'session_reset': sessionReset.value = { ...sessionReset.value, ...values }; break
      case 'privacy': privacy.value = { ...privacy.value, ...values }; break
      case 'approvals': approvals.value = { ...approvals.value, ...values }; break
      case 'telegram': telegram.value = { ...telegram.value, ...values }; break
      case 'discord': discord.value = { ...discord.value, ...values }; break
      case 'slack': slack.value = { ...slack.value, ...values }; break
      case 'whatsapp': whatsapp.value = { ...whatsapp.value, ...values }; break
      case 'matrix': matrix.value = { ...matrix.value, ...values }; break
      case 'wecom': wecom.value = { ...wecom.value, ...values }; break
      case 'feishu': feishu.value = { ...feishu.value, ...values }; break
      case 'dingtalk': dingtalk.value = { ...dingtalk.value, ...values }; break
      case 'qqbot': qqbot.value = { ...qqbot.value, ...values }; break
      case 'weixin': weixin.value = { ...weixin.value, ...values }; break
      case 'platforms': {
        for (const [key, val] of Object.entries(values)) {
          platforms.value = {
            ...platforms.value,
            [key]: { ...(platforms.value[key] || {}), ...(val as Record<string, any>) },
          }
        }
        break
      }
    }
  }

  async function saveSection(section: string, values: Record<string, any>) {
    saving.value = true
    try {
      await configApi.updateConfigSection(section, values)
    switch (section) {
      case 'display': display.value = { ...display.value, ...values }; break
      case 'agent': agent.value = { ...agent.value, ...values }; break
      case 'memory': memory.value = { ...memory.value, ...values }; break
      case 'session_reset': sessionReset.value = { ...sessionReset.value, ...values }; break
      case 'privacy': privacy.value = { ...privacy.value, ...values }; break
      case 'approvals': approvals.value = { ...approvals.value, ...values }; break
      case 'telegram': telegram.value = { ...telegram.value, ...values }; break
      case 'discord': discord.value = { ...discord.value, ...values }; break
      case 'slack': slack.value = { ...slack.value, ...values }; break
      case 'whatsapp': whatsapp.value = { ...whatsapp.value, ...values }; break
      case 'matrix': matrix.value = { ...matrix.value, ...values }; break
      case 'wechat': case 'wecom': wecom.value = { ...wecom.value, ...values }; break
      case 'feishu': feishu.value = { ...feishu.value, ...values }; break
      case 'dingtalk': dingtalk.value = { ...dingtalk.value, ...values }; break
      case 'qqbot': qqbot.value = { ...qqbot.value, ...values }; break
      case 'weixin': weixin.value = { ...weixin.value, ...values }; break
      case 'platforms': {
        // Deep-merge each platform's credentials
        for (const [key, val] of Object.entries(values)) {
          platforms.value = {
            ...platforms.value,
            [key]: { ...(platforms.value[key] || {}), ...(val as Record<string, any>) },
          }
        }
        break
      }
    }
    } finally {
      saving.value = false
    }
  }

  return {
    loading, saving,
    display, agent, memory, sessionReset, privacy, approvals,
    telegram, discord, slack, whatsapp, matrix, wecom, feishu, dingtalk, qqbot, weixin, platforms,
    fetchSettings, saveSection, updateLocal,
  }
})
