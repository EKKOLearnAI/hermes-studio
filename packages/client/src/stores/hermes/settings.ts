import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as configApi from '@/api/hermes/config'
import type { DisplayConfig, AgentConfig, MemoryConfig, SkillsConfig, CompressionConfig, SessionResetConfig, PrivacyConfig, ApprovalConfig, GatewayAutoStartConfig } from '@/api/hermes/config'

function parseProfileList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const item of value) {
    const name = String(item || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function mergeGatewayAutoStart(current: GatewayAutoStartConfig, values: Record<string, any>): GatewayAutoStartConfig {
  const next: GatewayAutoStartConfig = { ...current }
  if ('enabled' in values) {
    if (typeof values.enabled === 'boolean') next.enabled = values.enabled
    else delete next.enabled
  }
  if ('include' in values) {
    if (Array.isArray(values.include)) next.include = parseProfileList(values.include)
    else delete next.include
  }
  if ('exclude' in values) {
    if (Array.isArray(values.exclude)) next.exclude = parseProfileList(values.exclude)
    else delete next.exclude
  }
  if ('management' in values) {
    if (values.management === 'auto' || values.management === 'per_profile' || values.management === 'unified') {
      next.management = values.management
    } else {
      delete next.management
    }
  }
  return next
}

export const useSettingsStore = defineStore('settings', () => {
  const loading = ref(false)
  const saving = ref(false)

  const display = ref<DisplayConfig>({})
  const agent = ref<AgentConfig>({})
  const memory = ref<MemoryConfig>({})
  const skills = ref<SkillsConfig>({})
  const compression = ref<CompressionConfig>({})
  const sessionReset = ref<SessionResetConfig>({})
  const privacy = ref<PrivacyConfig>({})
  const approvals = ref<ApprovalConfig>({})
  const gatewayAutoStart = ref<GatewayAutoStartConfig>({})
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
      skills.value = data.skills || {}
      compression.value = data.compression || {}
      sessionReset.value = data.session_reset || {}
      privacy.value = data.privacy || {}
      approvals.value = data.approvals || {}
      gatewayAutoStart.value = data.gatewayAutoStart || {}
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
      case 'skills': skills.value = { ...skills.value, ...values }; break
      case 'compression': compression.value = { ...compression.value, ...values }; break
      case 'session_reset': sessionReset.value = { ...sessionReset.value, ...values }; break
      case 'privacy': privacy.value = { ...privacy.value, ...values }; break
      case 'approvals': approvals.value = { ...approvals.value, ...values }; break
      case 'gatewayAutoStart': gatewayAutoStart.value = mergeGatewayAutoStart(gatewayAutoStart.value, values); break
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

  async function saveSection(section: string, values: Record<string, any>, options?: { restart?: boolean }) {
    saving.value = true
    try {
      await configApi.updateConfigSection(section, values, options)
    switch (section) {
      case 'display': display.value = { ...display.value, ...values }; break
      case 'agent': agent.value = { ...agent.value, ...values }; break
      case 'memory': memory.value = { ...memory.value, ...values }; break
      case 'skills': skills.value = { ...skills.value, ...values }; break
      case 'compression': compression.value = { ...compression.value, ...values }; break
      case 'session_reset': sessionReset.value = { ...sessionReset.value, ...values }; break
      case 'privacy': privacy.value = { ...privacy.value, ...values }; break
      case 'approvals': approvals.value = { ...approvals.value, ...values }; break
      case 'gatewayAutoStart': gatewayAutoStart.value = mergeGatewayAutoStart(gatewayAutoStart.value, values); break
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
    display, agent, memory, skills, compression, sessionReset, privacy, approvals, gatewayAutoStart,
    telegram, discord, slack, whatsapp, matrix, wecom, feishu, dingtalk, qqbot, weixin, platforms,
    fetchSettings, saveSection, updateLocal,
  }
})
