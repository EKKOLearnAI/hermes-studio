<script setup lang="ts">
import { ref, reactive, onUnmounted } from 'vue'
import { NSwitch, NInput, NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { saveCredentials as saveCredsApi, fetchWeixinQrCode, pollWeixinQrStatus, saveWeixinCredentials } from '@/api/hermes/config'
import PlatformCard from './PlatformCard.vue'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

// Track saving state per platform.field
const saving = reactive<Record<string, boolean>>({})

function savingKey(platform: string, field: string) {
  return `${platform}.${field}`
}

function isSaving(platform: string, field: string) {
  return !!saving[savingKey(platform, field)]
}

// Immediate save for switches
async function immediateSave(platform: string, field: string, saveFn: () => Promise<void>) {
  const key = savingKey(platform, field)
  saving[key] = true
  try {
    await saveFn()
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(t('settings.saveFailed'))
  } finally {
    saving[key] = false
  }
}

async function saveChannel(platform: string, field: string, values: Record<string, any>) {
  immediateSave(platform, field, () => settingsStore.saveSection(platform, values))
}

// Save credentials to .env (matching hermes gateway setup behavior)
async function saveCredentials(platform: string, field: string, values: Record<string, any>) {
  immediateSave(platform, field, async () => {
    await saveCredsApi(platform, values)
    await settingsStore.fetchSettings()
  })
}

function getCreds(key: string) {
  return (settingsStore.platforms[key] || {}) as Record<string, any>
}

// Weixin QR code login state
const wxQrUrl = ref('')
const wxQrId = ref('')
const wxQrStatus = ref<'idle' | 'loading' | 'waiting' | 'scaned' | 'confirmed' | 'error' | 'expired'>('idle')
let wxPollTimer: ReturnType<typeof setTimeout> | null = null

async function startWeixinQrLogin() {
  wxQrStatus.value = 'loading'
  wxQrUrl.value = ''
  wxQrId.value = ''
  stopWeixinPoll()

  try {
    const data = await fetchWeixinQrCode()
    wxQrId.value = data.qrcode
    wxQrUrl.value = data.qrcode_url
    window.open(data.qrcode_url, '_blank')
    wxQrStatus.value = 'waiting'
    pollWeixinStatus()
  } catch (err: any) {
    wxQrStatus.value = 'error'
    message.error(err.message || t('platform.qrFetching'))
  }
}

function pollWeixinStatus() {
  if (!wxQrId.value) return
  wxPollTimer = setTimeout(async () => {
    try {
      const data = await pollWeixinQrStatus(wxQrId.value)
      if (data.status === 'wait') {
        pollWeixinStatus()
      } else if (data.status === 'scaned') {
        wxQrStatus.value = 'scaned'
        pollWeixinStatus()
      } else if (data.status === 'expired') {
        wxQrStatus.value = 'expired'
      } else if (data.status === 'confirmed') {
        wxQrStatus.value = 'confirmed'
        await saveWeixinCredentials({
          account_id: data.account_id!,
          token: data.token!,
          base_url: data.base_url,
        })
        await settingsStore.fetchSettings()
        message.success(t('settings.saved'))
      }
    } catch {
      pollWeixinStatus()
    }
  }, 3000)
}

function stopWeixinPoll() {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer)
    wxPollTimer = null
  }
}

onUnmounted(() => {
  stopWeixinPoll()
})

const platforms = [
  {
    key: 'telegram',
    name: 'Telegram',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
  },
  {
    key: 'discord',
    name: 'Discord',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>',
  },
  {
    key: 'slack',
    name: 'Slack',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 0a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V5.042zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1 2.523-2.52h6.313A2.528 2.528 0 0 1 24 18.956a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>',
  },
  {
    key: 'whatsapp',
    name: 'WhatsApp',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
  },
  {
    key: 'matrix',
    name: 'Matrix',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.48.324.448.217.786.619 1.017 1.205.24-.376.558-.702.956-.98.398-.277.872-.414 1.424-.414.41 0 .784.065 1.122.194.34.13.629.325.87.588.241.263.428.59.56.984.132.393.198.85.198 1.368v5.89h-2.49v-4.893c0-.268-.016-.525-.048-.77a1.627 1.627 0 00-.2-.63 1.028 1.028 0 00-.392-.426 1.294 1.294 0 00-.616-.134c-.277 0-.508.05-.693.15a1.043 1.043 0 00-.43.41 1.768 1.768 0 00-.214.616 4.15 4.15 0 00-.06.74v4.937H9.29v-4.937c0-.25-.01-.498-.032-.742a1.84 1.84 0 00-.166-.638.998.998 0 00-.363-.448 1.206 1.206 0 00-.624-.154c-.26 0-.483.048-.67.144a1.055 1.055 0 00-.436.402 1.744 1.744 0 00-.227.616 4.108 4.108 0 00-.063.74v4.937H5.21V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z"/></svg>',
  },
  {
    key: 'feishu',
    name: 'Feishu',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.59 3.41a2.25 2.25 0 0 1 3.182 0L13.5 7.14l-3.182 3.182L6.59 7.59a2.25 2.25 0 0 1 0-3.182zm5.303 5.303L15.075 5.53a2.25 2.25 0 0 1 3.182 3.182L15.075 11.894 11.893 8.713zM3.41 6.59a2.25 2.25 0 0 1 3.182 0l3.182 3.182-3.182 3.182a2.25 2.25 0 0 1-3.182-3.182L3.41 6.59zm5.303 5.303L11.894 15.075a2.25 2.25 0 0 1-3.182 3.182L5.53 15.075 8.713 11.893zm5.303-5.303L17.478 9.778a2.25 2.25 0 0 1-3.182 3.182L10.53 10.075l3.182-3.182 0 .023z"/></svg>',
  },
  {
    key: 'weixin',
    name: 'Weixin',
    exclusive: true,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178A1.17 1.17 0 014.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178 1.17 1.17 0 01-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.68 4.025c-3.694 0-6.69 2.462-6.69 5.496 0 3.034 2.996 5.496 6.69 5.496.753 0 1.477-.1 2.158-.28a.66.66 0 01.548.074l1.46.854a.25.25 0 00.127.041.224.224 0 00.221-.225c0-.055-.022-.109-.037-.162l-.298-1.131a.453.453 0 01.163-.509C21.81 18.613 22.77 16.973 22.77 15.512c0-3.034-2.996-5.496-6.69-5.496h.198zm-2.454 3.347c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902zm4.912 0c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902z"/></svg>',
  },
  {
    key: 'wecom',
    name: 'WeCom',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178A1.17 1.17 0 014.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178 1.17 1.17 0 01-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.68 4.025c-3.694 0-6.69 2.462-6.69 5.496 0 3.034 2.996 5.496 6.69 5.496.753 0 1.477-.1 2.158-.28a.66.66 0 01.548.074l1.46.854a.25.25 0 00.127.041.224.224 0 00.221-.225c0-.055-.022-.109-.037-.162l-.298-1.131a.453.453 0 01.163-.509C21.81 18.613 22.77 16.973 22.77 15.512c0-3.034-2.996-5.496-6.69-5.496h.198zm-2.454 3.347c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902zm4.912 0c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902z"/></svg>',
  },
]
</script>

<template>
  <section class="settings-section">
    <PlatformCard
      v-for="p in platforms"
      :key="p.key"
      :name="p.name"
      :icon="p.icon"
      :exclusive="p.exclusive"
      :config="settingsStore[p.key as keyof typeof settingsStore] as Record<string, any>"
      :credentials="getCreds(p.key)"
    >
      <!-- Telegram -->
      <template v-if="p.key === 'telegram'">
        <SettingRow :label="t('platform.botToken')" :hint="t('platform.botTokenHint')">
          <NInput :default-value="getCreds('telegram').token || ''" :loading="isSaving('telegram', 'token')" clearable size="small" class="input-lg" placeholder="123456:ABC-DEF..." @change="v => saveCredentials('telegram', 'token', { token: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionGroup')">
          <NSwitch :value="settingsStore.telegram.require_mention" :loading="isSaving('telegram', 'require_mention')" @update:value="v => saveChannel('telegram', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.reactions')" :hint="t('platform.reactionsHint')">
          <NSwitch :value="settingsStore.telegram.reactions" :loading="isSaving('telegram', 'reactions')" @update:value="v => saveChannel('telegram', 'reactions', { reactions: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChats')" :hint="t('platform.freeResponseChatsHint')">
          <NInput :default-value="settingsStore.telegram.free_response_chats || ''" :loading="isSaving('telegram', 'free_response_chats')" size="small" placeholder="chat_id1,chat_id2" @change="v => saveChannel('telegram', 'free_response_chats', { free_response_chats: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.mentionPatterns')" :hint="t('platform.mentionPatternsHint')">
          <NInput :default-value="(settingsStore.telegram.mention_patterns || []).join(', ')" :loading="isSaving('telegram', 'mention_patterns')" size="small" placeholder="pattern1, pattern2" @change="v => saveChannel('telegram', 'mention_patterns', { mention_patterns: v ? v.split(',').map(s => s.trim()) : [] })" />
        </SettingRow>
      </template>

      <!-- Discord -->
      <template v-if="p.key === 'discord'">
        <SettingRow :label="t('platform.botToken')" :hint="t('platform.botTokenHint')">
          <NInput :default-value="getCreds('discord').token || ''" :loading="isSaving('discord', 'token')" clearable size="small" class="input-lg" placeholder="Bot token..." @change="v => saveCredentials('discord', 'token', { token: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionChannel')">
          <NSwitch :value="settingsStore.discord.require_mention" :loading="isSaving('discord', 'require_mention')" @update:value="v => saveChannel('discord', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.autoThread')" :hint="t('platform.autoThreadHint')">
          <NSwitch :value="settingsStore.discord.auto_thread" :loading="isSaving('discord', 'auto_thread')" @update:value="v => saveChannel('discord', 'auto_thread', { auto_thread: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.reactions')" :hint="t('platform.reactionsHint')">
          <NSwitch :value="settingsStore.discord.reactions" :loading="isSaving('discord', 'reactions')" @update:value="v => saveChannel('discord', 'reactions', { reactions: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChannels')" :hint="t('platform.freeResponseChannelsHint')">
          <NInput :default-value="settingsStore.discord.free_response_channels || ''" :loading="isSaving('discord', 'free_response_channels')" size="small" placeholder="channel_id1,channel_id2" @change="v => saveChannel('discord', 'free_response_channels', { free_response_channels: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.allowedChannels')" :hint="t('platform.allowedChannelsHint')">
          <NInput :default-value="settingsStore.discord.allowed_channels || ''" :loading="isSaving('discord', 'allowed_channels')" size="small" placeholder="channel_id1,channel_id2" @change="v => saveChannel('discord', 'allowed_channels', { allowed_channels: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.ignoredChannels')" :hint="t('platform.ignoredChannelsHint')">
          <NInput :default-value="settingsStore.discord.ignored_channels || ''" :loading="isSaving('discord', 'ignored_channels')" size="small" placeholder="channel_id1,channel_id2" @change="v => saveChannel('discord', 'ignored_channels', { ignored_channels: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.noThreadChannels')" :hint="t('platform.noThreadChannelsHint')">
          <NInput :default-value="settingsStore.discord.no_thread_channels || ''" :loading="isSaving('discord', 'no_thread_channels')" size="small" placeholder="channel_id1,channel_id2" @change="v => saveChannel('discord', 'no_thread_channels', { no_thread_channels: v })" />
        </SettingRow>
      </template>

      <!-- Slack -->
      <template v-if="p.key === 'slack'">
        <SettingRow :label="t('platform.botToken')" :hint="t('platform.botTokenHint')">
          <NInput :default-value="getCreds('slack').token || ''" :loading="isSaving('slack', 'token')" clearable size="small" class="input-lg" placeholder="xoxb-..." @change="v => saveCredentials('slack', 'token', { token: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionChannel')">
          <NSwitch :value="settingsStore.slack.require_mention" :loading="isSaving('slack', 'require_mention')" @update:value="v => saveChannel('slack', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.allowBots')" :hint="t('platform.allowBotsHint')">
          <NSwitch :value="settingsStore.slack.allow_bots" :loading="isSaving('slack', 'allow_bots')" @update:value="v => saveChannel('slack', 'allow_bots', { allow_bots: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChannels')" :hint="t('platform.freeResponseChannelsHint')">
          <NInput :default-value="settingsStore.slack.free_response_channels || ''" :loading="isSaving('slack', 'free_response_channels')" size="small" placeholder="channel_id1,channel_id2" @change="v => saveChannel('slack', 'free_response_channels', { free_response_channels: v })" />
        </SettingRow>
      </template>

      <!-- WhatsApp -->
      <template v-if="p.key === 'whatsapp'">
        <SettingRow :label="t('platform.waEnabled')" :hint="t('platform.waEnabledHint')">
          <NSwitch :value="getCreds('whatsapp').enabled" :loading="isSaving('whatsapp', 'enabled')" @update:value="v => saveCredentials('whatsapp', 'enabled', { enabled: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionGroup')">
          <NSwitch :value="settingsStore.whatsapp.require_mention" :loading="isSaving('whatsapp', 'require_mention')" @update:value="v => saveChannel('whatsapp', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChats')" :hint="t('platform.freeResponseChatsHint')">
          <NInput :default-value="settingsStore.whatsapp.free_response_chats || ''" :loading="isSaving('whatsapp', 'free_response_chats')" size="small" placeholder="chat_id1,chat_id2" @change="v => saveChannel('whatsapp', 'free_response_chats', { free_response_chats: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.mentionPatterns')" :hint="t('platform.mentionPatternsHint')">
          <NInput :default-value="(settingsStore.whatsapp.mention_patterns || []).join(', ')" :loading="isSaving('whatsapp', 'mention_patterns')" size="small" placeholder="pattern1, pattern2" @change="v => saveChannel('whatsapp', 'mention_patterns', { mention_patterns: v ? v.split(',').map(s => s.trim()) : [] })" />
        </SettingRow>
      </template>

      <!-- Matrix -->
      <template v-if="p.key === 'matrix'">
        <SettingRow :label="t('platform.accessToken')" :hint="t('platform.accessTokenHint')">
          <NInput :default-value="getCreds('matrix').token || ''" :loading="isSaving('matrix', 'token')" clearable size="small" class="input-lg" placeholder="syt_..." @change="v => saveCredentials('matrix', 'token', { token: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.homeserver')" :hint="t('platform.homeserverHint')">
          <NInput :default-value="getCreds('matrix').extra?.homeserver || ''" :loading="isSaving('matrix', 'homeserver')" clearable size="small" class="input-lg" placeholder="https://matrix.org" @change="v => saveCredentials('matrix', 'homeserver', { extra: { ...getCreds('matrix').extra, homeserver: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionRoom')">
          <NSwitch :value="settingsStore.matrix.require_mention" :loading="isSaving('matrix', 'require_mention')" @update:value="v => saveChannel('matrix', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.autoThread')" :hint="t('platform.autoThreadHintRoom')">
          <NSwitch :value="settingsStore.matrix.auto_thread" :loading="isSaving('matrix', 'auto_thread')" @update:value="v => saveChannel('matrix', 'auto_thread', { auto_thread: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.dmMentionThreads')" :hint="t('platform.dmMentionThreadsHint')">
          <NSwitch :value="settingsStore.matrix.dm_mention_threads" :loading="isSaving('matrix', 'dm_mention_threads')" @update:value="v => saveChannel('matrix', 'dm_mention_threads', { dm_mention_threads: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseRooms')" :hint="t('platform.freeResponseRoomsHint')">
          <NInput :default-value="settingsStore.matrix.free_response_rooms || ''" :loading="isSaving('matrix', 'free_response_rooms')" size="small" placeholder="room_id1,room_id2" @change="v => saveChannel('matrix', 'free_response_rooms', { free_response_rooms: v })" />
        </SettingRow>
      </template>

      <!-- Feishu -->
      <template v-if="p.key === 'feishu'">
        <SettingRow :label="t('platform.appId')" :hint="t('platform.appIdHint')">
          <NInput :default-value="getCreds('feishu').extra?.app_id || ''" :loading="isSaving('feishu', 'app_id')" clearable size="small" class="input-lg" placeholder="cli_..." @change="v => saveCredentials('feishu', 'app_id', { extra: { ...getCreds('feishu').extra, app_id: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.appSecret')" :hint="t('platform.appSecretHint')">
          <NInput :default-value="getCreds('feishu').extra?.app_secret || ''" :loading="isSaving('feishu', 'app_secret')" clearable size="small" class="input-lg" placeholder="App Secret" @change="v => saveCredentials('feishu', 'app_secret', { extra: { ...getCreds('feishu').extra, app_secret: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionGroup')">
          <NSwitch :value="settingsStore.feishu.require_mention" :loading="isSaving('feishu', 'require_mention')" @update:value="v => saveChannel('feishu', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChats')" :hint="t('platform.freeResponseChatsHint')">
          <NInput :default-value="settingsStore.feishu.free_response_chats || ''" :loading="isSaving('feishu', 'free_response_chats')" size="small" placeholder="chat_id1,chat_id2" @change="v => saveChannel('feishu', 'free_response_chats', { free_response_chats: v })" />
        </SettingRow>
      </template>

      <!-- DingTalk -->
      <template v-if="p.key === 'dingtalk'">
        <SettingRow :label="t('platform.clientId')" :hint="t('platform.clientIdHint')">
          <NInput :default-value="getCreds('dingtalk').extra?.client_id || ''" :loading="isSaving('dingtalk', 'client_id')" clearable size="small" class="input-lg" placeholder="Client ID" @change="v => saveCredentials('dingtalk', 'client_id', { extra: { ...getCreds('dingtalk').extra, client_id: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.clientSecret')" :hint="t('platform.clientSecretHint')">
          <NInput :default-value="getCreds('dingtalk').extra?.client_secret || ''" :loading="isSaving('dingtalk', 'client_secret')" clearable size="small" class="input-lg" placeholder="Client Secret" @change="v => saveCredentials('dingtalk', 'client_secret', { extra: { ...getCreds('dingtalk').extra, client_secret: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.requireMention')" :hint="t('platform.requireMentionGroup')">
          <NSwitch :value="settingsStore.dingtalk.require_mention" :loading="isSaving('dingtalk', 'require_mention')" @update:value="v => saveChannel('dingtalk', 'require_mention', { require_mention: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.freeResponseChats')" :hint="t('platform.freeResponseChatsHint')">
          <NInput :default-value="settingsStore.dingtalk.free_response_chats || ''" :loading="isSaving('dingtalk', 'free_response_chats')" size="small" placeholder="chat_id1,chat_id2" @change="v => saveChannel('dingtalk', 'free_response_chats', { free_response_chats: v })" />
        </SettingRow>
      </template>

      <!-- Weixin -->
      <template v-if="p.key === 'weixin'">
        <div class="weixin-qr-section">
          <NButton
            v-if="wxQrStatus === 'idle' || wxQrStatus === 'error' || wxQrStatus === 'expired' || wxQrStatus === 'confirmed'"
            type="primary"
            size="small"
            @click="startWeixinQrLogin"
          >
            {{ wxQrStatus === 'confirmed' ? t('platform.qrRelogin') : t('platform.qrLogin') }}
          </NButton>
          <div v-if="wxQrStatus === 'loading'" class="weixin-qr-loading">
            <NSpin size="small" />
            <span>{{ t('platform.qrFetching') }}</span>
          </div>
          <div v-if="wxQrStatus === 'waiting' || wxQrStatus === 'scaned'" class="weixin-qr-hint">
            {{ wxQrStatus === 'scaned' ? t('platform.qrScanedHint') : t('platform.qrScanHint') }}
          </div>
        </div>
        <SettingRow :label="t('platform.weixinToken')" :hint="t('platform.weixinTokenHint')">
          <NInput :default-value="getCreds('weixin').token || ''" :loading="isSaving('weixin', 'token')" clearable size="small" class="input-lg" placeholder="Token" @change="v => saveCredentials('weixin', 'token', { token: v })" />
        </SettingRow>
        <SettingRow :label="t('platform.accountId')" :hint="t('platform.accountIdHint')">
          <NInput :default-value="getCreds('weixin').extra?.account_id || ''" :loading="isSaving('weixin', 'account_id')" clearable size="small" class="input-lg" placeholder="Account ID" @change="v => saveCredentials('weixin', 'account_id', { extra: { ...getCreds('weixin').extra, account_id: v } })" />
        </SettingRow>
      </template>

      <!-- WeCom -->
      <template v-if="p.key === 'wecom'">
        <SettingRow :label="t('platform.botId')" :hint="t('platform.botIdHint')">
          <NInput :default-value="getCreds('wecom').extra?.bot_id || ''" :loading="isSaving('wecom', 'bot_id')" clearable size="small" class="input-lg" placeholder="Bot ID" @change="v => saveCredentials('wecom', 'bot_id', { extra: { ...getCreds('wecom').extra, bot_id: v } })" />
        </SettingRow>
        <SettingRow :label="t('platform.appSecret')" :hint="t('platform.wecomSecretHint')">
          <NInput :default-value="getCreds('wecom').extra?.secret || ''" :loading="isSaving('wecom', 'secret')" clearable size="small" class="input-lg" placeholder="Secret" @change="v => saveCredentials('wecom', 'secret', { extra: { ...getCreds('wecom').extra, secret: v } })" />
        </SettingRow>
      </template>
    </PlatformCard>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.weixin-qr-section {
  margin-top: 12px;
  margin-bottom: 12px;
}

.weixin-qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: $text-muted;
  font-size: 13px;
}

.weixin-qr-hint {
  font-size: 13px;
  color: $text-secondary;
}
</style>
