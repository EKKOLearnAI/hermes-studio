<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { LifeContactDto, LifeHandoffDto, LifeOptionDto } from '@/api/hermes/life-orchestration'
import { lifeMoney } from './life-ui'
defineProps<{ options: LifeOptionDto[]; contacts: LifeContactDto[]; handoffs: LifeHandoffDto[] }>()
const { t } = useI18n()
</script>
<template><section class="panel" data-test="life-library-panel"><h2>{{ t('life.library.title') }}</h2><p>{{ t('life.library.summary') }}</p>
  <div class="cards"><article v-for="item in options" :key="item.id"><span>{{ item.kind }} · {{ item.locationClass }}</span><h3>{{ item.title }}</h3>
    <p>{{ item.durationMinutes }} {{ t('life.planner.minutes') }} · {{ lifeMoney(item.cost) }}</p><small>{{ item.categoryTags.join(' · ') }}</small></article>
    <p v-if="!options.length">{{ t('life.library.empty') }}</p></div>
  <details><summary>{{ t('life.library.contacts') }} ({{ contacts.length }})</summary><ul><li v-for="contact in contacts" :key="contact.id">{{ contact.alias }} · {{ contact.relationshipTags.join(', ') || '—' }}</li></ul></details>
  <details><summary>{{ t('life.library.handoffs') }} ({{ handoffs.length }})</summary><ul><li v-for="item in handoffs" :key="item.id">{{ item.kind }} · {{ item.targetCapabilityId }} · {{ item.state }}</li></ul></details>
</section></template>
<style scoped>.panel{padding:18px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-color)}h2{margin:0 0 5px}.panel>p,small{color:var(--text-color-3)}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0}.cards article{padding:12px;border-radius:8px;background:var(--action-color)}.cards h3,.cards p{margin:4px 0}.cards span{font-size:11px;color:var(--primary-color)}summary{padding:8px 0;cursor:pointer}ul{margin:0;padding-left:20px;font-size:12px}@media(max-width:600px){.cards{grid-template-columns:1fr}}</style>
