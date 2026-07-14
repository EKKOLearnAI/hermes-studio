<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HealthSettingsDto } from '@/api/hermes/health-loop'

const props = withDefaults(defineProps<{ settings: HealthSettingsDto | null; busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ 'set-live': [enabled: boolean] }>()
const { t } = useI18n()
const confirmation = ref('')
const LIVE_CONFIRMATION = 'LIVE WEIXIN'
const live = computed(() => props.settings?.liveDeliveryEnabled === true)
const confirmed = computed(() => confirmation.value === LIVE_CONFIRMATION)

watch(live, () => { confirmation.value = '' })
</script>

<template>
  <section class="loop-panel automation" data-test="health-automation-panel" aria-labelledby="health-automation-title">
    <div class="heading">
      <h3 id="health-automation-title">{{ t('health.loop.automation.title') }}</h3>
      <span data-test="automation-mode" :data-live="live">
        {{ live ? t('health.loop.automation.live') : t('health.loop.automation.shadow') }}
      </span>
    </div>
    <p>{{ t('health.loop.automation.summary') }}</p>
    <template v-if="!live">
      <label for="live-weixin-confirmation">{{ t('health.loop.automation.confirmationLabel', { code: LIVE_CONFIRMATION }) }}</label>
      <input
        id="live-weixin-confirmation"
        v-model="confirmation"
        data-test="live-confirmation-input"
        autocomplete="off"
        :disabled="busy"
        :placeholder="LIVE_CONFIRMATION"
      >
      <button type="button" data-test="enable-live-weixin" :disabled="busy || !confirmed" @click="emit('set-live', true)">
        {{ t('health.loop.automation.liveWeixin') }}
      </button>
    </template>
    <button v-else type="button" class="secondary" data-test="disable-live-weixin" :disabled="busy" @click="emit('set-live', false)">
      {{ t('health.loop.automation.returnShadow') }}
    </button>
  </section>
</template>

<style scoped lang="scss">
.loop-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-color); padding: 16px; }
.automation { display: grid; gap: 10px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3, p { margin: 0; }
p, label { color: var(--text-color-2); font-size: 13px; }
.heading span { border: 1px solid var(--border-color); border-radius: 999px; padding: 4px 8px; font-size: 12px; }
.heading span[data-live="true"] { border-color: var(--success-color); color: var(--success-color); }
input { min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-color); padding: 8px; }
button { border: 0; border-radius: 8px; background: var(--primary-color); color: white; cursor: pointer; font: inherit; padding: 9px 12px; }
button.secondary { border: 1px solid var(--border-color); background: transparent; color: var(--text-color); }
button:disabled { cursor: not-allowed; opacity: .5; }
</style>
