<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HomeInventoryItemDto } from '@/api/hermes/home'

defineProps<{ items: HomeInventoryItemDto[]; canWrite: boolean; busy?: boolean }>()
const emit = defineEmits<{ adjust: [payload: { id: string; delta: number; reason: string }] }>()
const { t } = useI18n()
const pending = ref<{ item: HomeInventoryItemDto; delta: number } | null>(null)

function isLow(item: HomeInventoryItemDto): boolean {
  return item.lowStockThreshold !== null && item.quantity <= item.lowStockThreshold
}
function confirmAdjustment() {
  if (!pending.value) return
  emit('adjust', { id: pending.value.item.id, delta: pending.value.delta, reason: t('home.inventory.adjustmentReason') })
  pending.value = null
}
</script>

<template>
  <section class="inventory-panel" data-test="home-inventory-panel">
    <header><h2>{{ t('home.inventory.title') }}</h2><span>{{ items.length }}</span></header>
    <p v-if="!items.length" class="empty">{{ t('home.inventory.empty') }}</p>
    <div v-else class="inventory-list">
      <article v-for="item in items" :key="item.id" :class="{ low: isLow(item) }">
        <div>
          <span v-if="isLow(item)" class="low-stock">{{ t('home.inventory.lowStock') }}</span>
          <h3>{{ item.name }}</h3>
          <p>{{ t('home.inventory.quantity') }}: <strong>{{ item.quantity }}</strong> {{ item.unit }}</p>
        </div>
        <div class="item-actions">
          <button :disabled="!canWrite || busy || item.quantity < 1" data-test="home-inventory-use"
            @click="pending = { item, delta: -1 }">{{ t('home.inventory.useOne') }}</button>
          <button :disabled="!canWrite || busy" data-test="home-inventory-add"
            @click="pending = { item, delta: 1 }">{{ t('home.inventory.addOne') }}</button>
        </div>
      </article>
    </div>

    <div v-if="pending" class="inventory-confirm" role="dialog" aria-modal="true" data-test="home-inventory-confirmation">
      <div>
        <h3>{{ pending.item.name }}</h3>
        <p>{{ pending.delta > 0 ? t('home.inventory.addOne') : t('home.inventory.useOne') }}</p>
        <div class="confirm-actions">
          <button @click="pending = null">{{ t('home.devices.cancel') }}</button>
          <button class="primary" data-test="home-inventory-confirm" @click="confirmAdjustment">{{ t('home.devices.confirm') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.inventory-panel { position: relative; padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-color); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
h2, h3, p { margin: 0; }
header span, .empty { color: var(--text-color-3); }
.inventory-list { display: grid; gap: 9px; }
.inventory-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; }
.inventory-list article.low { border-color: color-mix(in srgb, var(--warning-color) 50%, var(--border-color)); }
.inventory-list h3 { margin-top: 3px; font-size: 15px; }
.inventory-list p { margin-top: 4px; color: var(--text-color-2); font-size: 12px; }
.low-stock { color: var(--warning-color); font-size: 10px; font-weight: 750; text-transform: uppercase; }
.item-actions, .confirm-actions { display: flex; gap: 7px; }
button { padding: 6px 9px; border: 1px solid var(--border-color); border-radius: 6px; background: transparent; color: var(--text-color); cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
.inventory-confirm { position: absolute; inset: 0; display: grid; place-items: center; padding: 18px; border-radius: 12px; background: color-mix(in srgb, var(--modal-color, var(--card-color)) 94%, transparent); }
.inventory-confirm > div { width: min(320px, 100%); padding: 16px; border: 1px solid var(--border-color); border-radius: 9px; background: var(--card-color); }
.inventory-confirm p { margin: 8px 0 16px; color: var(--text-color-2); }
.confirm-actions { justify-content: flex-end; }
.primary { border-color: var(--primary-color); background: var(--primary-color); color: white; }
@media (max-width: 560px) { .inventory-list article { align-items: flex-start; flex-direction: column; } }
</style>
