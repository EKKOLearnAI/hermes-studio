<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NSpin } from 'naive-ui'
import { openDshPluginUi, closeDshPluginUi } from '@/api/coding-agents/dsh'
import { getBaseUrlValue } from '@/api/client'
const { t } = useI18n()
const src = ref('')
const frame = ref<HTMLIFrameElement>()
const loading = ref(true)
const failed = ref(false)
let id = '', sequence = 0, disposed = false
async function refresh() {
  const current = ++sequence
  loading.value = true; failed.value = false
  try {
    const session = await openDshPluginUi()
    if (disposed || current !== sequence) { void closeDshPluginUi(session.id).catch(() => {}); return }
    const previous = id; id = session.id
    src.value = new URL(session.path, getBaseUrlValue() || window.location.origin).href
    if (previous) void closeDshPluginUi(previous).catch(() => {})
  } catch { if (current === sequence) { failed.value = true; loading.value = false } }
}
function ready(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== new URL(src.value).origin) return
  if (event.data?.type === 'studio-dsh-ui-ready') loading.value = false
  if (event.data?.type === 'studio-dsh-ui-expired') { failed.value = true; loading.value = false }
}
onMounted(() => { window.addEventListener('message', ready); void refresh() })
onUnmounted(() => { disposed = true; window.removeEventListener('message', ready); if (id) void closeDshPluginUi(id).catch(() => {}) })
defineExpose({ refresh })
</script>
<template>
  <div class="native-settings" data-testid="dsh-plugin-settings">
    <NSpin v-if="loading" class="loading" />
    <NAlert v-if="failed" type="error">{{ t('dshPlugins.settingsUnavailable') }}</NAlert>
    <iframe v-if="src" ref="frame" :src="src" :title="t('dshPlugins.configurationTab')" referrerpolicy="no-referrer" class="native-slot" @error="failed = true; loading = false" />
  </div>
</template>
<style scoped>
.native-settings { position: relative; min-height: 360px; height: 100%; }
.native-slot { display: block; width: 100%; height: 100%; min-height: 480px; border: 0; }
.loading { position: absolute; inset-block-start: 12px; inset-inline-end: 12px; }
</style>
