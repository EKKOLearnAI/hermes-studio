<script setup lang="ts">
import { NButton } from 'naive-ui'

withDefaults(defineProps<{
  show: boolean
  title: string
  description: string
  details?: string
  confirmLabel?: string
  cancelLabel?: string
  queueLabel?: string
}>(), {
  details: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  queueLabel: '',
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <Teleport to="body">
    <Transition name="security-confirm">
      <div
        v-if="show"
        class="security-confirm-backdrop"
        role="presentation"
      >
        <section
          class="security-confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="security-confirm-title"
        >
          <div class="security-confirm-icon" aria-hidden="true">!</div>
          <div class="security-confirm-body">
            <p class="security-confirm-kicker">Security Confirmation</p>
            <h2 id="security-confirm-title">{{ title }}</h2>
            <span v-if="queueLabel" class="security-confirm-queue">{{ queueLabel }}</span>
            <p>{{ description }}</p>

            <pre v-if="details">{{ details }}</pre>

            <div class="security-confirm-actions">
              <NButton size="large" secondary @click="emit('cancel')">
                {{ cancelLabel }}
              </NButton>
              <NButton size="large" type="error" @click="emit('confirm')">
                {{ confirmLabel }}
              </NButton>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
.security-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 5100;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 50% 0%, rgba(248, 113, 113, 0.2), transparent 38%),
    rgba(10, 10, 12, 0.6);
  backdrop-filter: blur(18px);
}

.security-confirm-modal {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 16px;
  width: min(560px, 100%);
  padding: 18px;
  border: 1px solid rgba(248, 113, 113, 0.42);
  border-radius: 12px;
  color: #fff7f7;
  background:
    linear-gradient(180deg, rgba(127, 29, 29, 0.82), rgba(30, 10, 12, 0.9)),
    rgba(20, 8, 10, 0.9);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4);
}

.security-confirm-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border: 1px solid rgba(254, 202, 202, 0.24);
  border-radius: 10px;
  color: #fecaca;
  background: rgba(248, 113, 113, 0.16);
  font-size: 22px;
  font-weight: 950;
}

.security-confirm-body {
  min-width: 0;
}

.security-confirm-kicker {
  margin: 0 0 6px;
  color: #fecaca;
  font-size: 11px;
  font-weight: 900;
  line-height: 1.2;
  text-transform: uppercase;
}

.security-confirm-modal h2 {
  margin: 0;
  color: #fff;
  font-size: 20px;
  font-weight: 850;
  line-height: 1.25;
}

.security-confirm-queue {
  display: inline-flex;
  margin-top: 8px;
  padding: 4px 8px;
  border: 1px solid rgba(254, 202, 202, 0.22);
  border-radius: 999px;
  color: #fecaca;
  background: rgba(248, 113, 113, 0.12);
  font-size: 11px;
  font-weight: 900;
  line-height: 1.2;
}

.security-confirm-modal p {
  margin: 10px 0 0;
  color: rgba(255, 247, 247, 0.78);
  font-size: 13px;
  line-height: 1.5;
}

.security-confirm-modal pre {
  max-height: 180px;
  margin: 16px 0 0;
  overflow: auto;
  padding: 12px;
  border: 1px solid rgba(254, 202, 202, 0.22);
  border-radius: 10px;
  color: #fff;
  background: rgba(17, 8, 10, 0.74);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.security-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.security-confirm-actions :deep(.n-button) {
  min-width: 112px;
}

.security-confirm-enter-active,
.security-confirm-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.security-confirm-enter-from,
.security-confirm-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 520px) {
  .security-confirm-backdrop {
    align-items: end;
    padding: 12px;
  }

  .security-confirm-modal {
    grid-template-columns: 1fr;
  }

  .security-confirm-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .security-confirm-actions :deep(.n-button) {
    min-width: 0;
  }
}
</style>
