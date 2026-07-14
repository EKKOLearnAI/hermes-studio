<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { HealthConsentManifestDto } from '@/api/hermes/health-loop'

withDefaults(defineProps<{ open: boolean; manifest: HealthConsentManifestDto; busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ confirm: [manifest: HealthConsentManifestDto]; cancel: [] }>()
const { t } = useI18n()
</script>

<template>
  <section
    v-if="open"
    class="consent"
    role="dialog"
    aria-modal="true"
    aria-labelledby="health-consent-title"
    data-test="health-consent-dialog"
    tabindex="-1"
    @keydown.esc.stop.prevent="emit('cancel')"
  >
    <div class="card">
      <span class="eyebrow">{{ t('health.loop.consent.oneTime') }}</span>
      <h3 id="health-consent-title">{{ t('health.loop.consent.title') }}</h3>
      <p>{{ t('health.loop.consent.summary') }}</p>
      <dl>
        <dt>{{ t('health.loop.consent.processor') }}</dt><dd>{{ manifest.processor }}</dd>
        <dt>{{ t('health.loop.consent.purpose') }}</dt><dd>{{ manifest.purpose }}</dd>
        <dt>{{ t('health.loop.consent.artifacts') }}</dt><dd>{{ manifest.artifactIds.join(', ') }}</dd>
        <dt>{{ t('health.loop.consent.regions') }}</dt><dd>{{ manifest.selectedRegions.join(', ') || '—' }}</dd>
        <dt>{{ t('health.loop.consent.fields') }}</dt><dd>{{ manifest.requestedFields.join(', ') }}</dd>
        <dt>{{ t('health.loop.consent.retention') }}</dt><dd>{{ manifest.retention }}</dd>
      </dl>
      <div class="actions">
        <button type="button" data-test="consent-cancel" :disabled="busy" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="primary"
          data-test="consent-confirm"
          :aria-label="t('health.loop.consent.confirm')"
          :disabled="busy"
          @click="emit('confirm', manifest)"
        >
          {{ busy ? t('health.loop.consent.processing') : t('health.loop.consent.confirm') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.consent { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgba(0, 0, 0, .55); padding: 20px; }
.card { width: min(560px, 100%); max-height: min(700px, 90vh); overflow: auto; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); padding: 20px; }
.eyebrow { color: var(--warning-color); font-size: 12px; text-transform: uppercase; }
h3 { margin: 5px 0; }
p { color: var(--text-color-2); }
dl { display: grid; grid-template-columns: minmax(100px, .5fr) minmax(0, 1fr); gap: 9px 12px; }
dt { color: var(--text-color-3); }
dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
button { border: 1px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-color); cursor: pointer; font: inherit; padding: 8px 12px; }
button.primary { border-color: var(--primary-color); background: var(--primary-color); color: white; }
</style>
