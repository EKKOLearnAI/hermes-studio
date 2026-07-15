<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InternetSearchOrder } from '@/api/hermes/internet-execution'

const props = defineProps<{ canWrite: boolean; busy: boolean; available: boolean }>()
const emit = defineEmits<{
  search: [input: { query: string; limit: number; page: number; order: InternetSearchOrder }]
  inspect: [input: { bvid: string }]
}>()
const { t } = useI18n()
const query = ref('')
const limit = ref(10)
const page = ref(1)
const order = ref<InternetSearchOrder>('relevance')
const bvid = ref('')
const disabled = computed(() => !props.canWrite || props.busy || !props.available)
const validQuery = computed(() => query.value.trim() === query.value && query.value.length > 0 && query.value.length <= 120)
const validBvid = computed(() => /^BV[0-9A-Za-z]{10}$/.test(bvid.value))
function submitSearch() { if (!disabled.value && validQuery.value) emit('search', { query: query.value, limit: limit.value, page: page.value, order: order.value }) }
function submitInspect() { if (!disabled.value && validBvid.value) emit('inspect', { bvid: bvid.value }) }
</script>

<template>
  <section class="panel" data-test="internet-intent-panel">
    <h2>{{ t('internetExecution.intent.title') }}</h2>
    <p class="summary">{{ t('internetExecution.intent.summary') }}</p>
    <form data-test="internet-search-form" @submit.prevent="submitSearch">
      <label>{{ t('internetExecution.intent.searchLabel') }}
        <input v-model="query" data-test="internet-search-query" maxlength="120" :placeholder="t('internetExecution.intent.searchPlaceholder')" />
      </label>
      <div class="bounded-fields">
        <label>{{ t('internetExecution.intent.order') }}<select v-model="order">
          <option value="relevance">{{ t('internetExecution.intent.relevance') }}</option>
          <option value="newest">{{ t('internetExecution.intent.newest') }}</option>
          <option value="most_viewed">{{ t('internetExecution.intent.mostViewed') }}</option>
        </select></label>
        <label>{{ t('internetExecution.intent.limit') }}<input v-model.number="limit" type="number" min="1" max="20" /></label>
        <label>{{ t('internetExecution.intent.page') }}<input v-model.number="page" type="number" min="1" max="10" /></label>
      </div>
      <button data-test="internet-search-submit" :disabled="disabled || !validQuery">{{ t('internetExecution.intent.search') }}</button>
    </form>
    <div class="divider"><span>{{ t('internetExecution.intent.or') }}</span></div>
    <form data-test="internet-inspect-form" @submit.prevent="submitInspect">
      <label>{{ t('internetExecution.intent.bvidLabel') }}
        <input v-model.trim="bvid" data-test="internet-inspect-bvid" maxlength="12" placeholder="BV1xxxxxxxxx" />
      </label>
      <button data-test="internet-inspect-submit" :disabled="disabled || !validBvid">{{ t('internetExecution.intent.inspect') }}</button>
    </form>
    <p v-if="!canWrite" class="notice">{{ t('internetExecution.readOnly') }}</p>
    <p v-else-if="!available" class="notice">{{ t('internetExecution.intent.runtimeUnavailable') }}</p>
    <p class="boundary">{{ t('internetExecution.intent.boundary') }}</p>
  </section>
</template>

<style scoped>
.panel { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); } h2 { margin: 0; font-size: 18px; }.summary,.boundary { color: var(--text-color-2); }.summary { margin: 5px 0 16px; }.boundary { margin: 13px 0 0; font-size: 12px; }
form { display: grid; gap: 10px; } label { display: grid; gap: 5px; color: var(--text-color-2); font-size: 12px; } input,select { width: 100%; box-sizing: border-box; padding: 8px 9px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--input-color); color: var(--text-color); }
.bounded-fields { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; } button { justify-self: start; padding: 8px 13px; border: 0; border-radius: 7px; background: var(--primary-color); color: white; cursor: pointer; } button:disabled { opacity: .45; cursor: not-allowed; }
.divider { display: flex; align-items: center; gap: 8px; margin: 16px 0; color: var(--text-color-3); font-size: 11px; }.divider::before,.divider::after { content: ''; flex: 1; border-top: 1px solid var(--border-color); }.notice { padding: 9px; border-radius: 7px; background: var(--action-color); color: var(--text-color-2); }
@media (max-width: 500px) { .bounded-fields { grid-template-columns: 1fr; } }
</style>
