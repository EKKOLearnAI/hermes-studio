<script setup lang="ts">
import { useAuroraGovernanceStore } from '@/stores/hermes/aurora-governance'
import SecurityConfirmModal from '@/components/hermes/aurora/SecurityConfirmModal.vue'

const governanceStore = useAuroraGovernanceStore()
</script>

<template>
  <SecurityConfirmModal
    :show="governanceStore.hasPendingConfirmation"
    :title="governanceStore.activeConfirmation?.title || ''"
    :description="governanceStore.activeConfirmation?.description || ''"
    :details="governanceStore.activeConfirmation?.details || ''"
    :confirm-label="governanceStore.activeConfirmation?.confirmLabel || 'Confirm'"
    :cancel-label="governanceStore.activeConfirmation?.cancelLabel || 'Cancel'"
    :queue-label="governanceStore.pendingCount > 1 ? `1 of ${governanceStore.pendingCount} approvals queued` : ''"
    @confirm="governanceStore.confirmActive"
    @cancel="governanceStore.cancelActive"
  />
</template>
