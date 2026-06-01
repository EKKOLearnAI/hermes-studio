<script setup lang="ts">
import { computed } from "vue";
import { NButton } from "naive-ui";
import type { PendingApproval } from "@/stores/hermes/chat";
import { isL4LockedTool } from "@/services/hermes/approval-gateway";

const props = defineProps<{
  approval: PendingApproval | null | undefined;
}>();

const emit = defineEmits<{
  approve: [];
  reject: [];
}>();

const command = computed(() => props.approval?.command?.trim() || "(empty command)");
const description = computed(() => props.approval?.description?.trim() || "L4_Locked terminal execution requires explicit approval.");
const isTerminalApproval = computed(() =>
  props.approval?.securityLevel === "L4_Locked" || isL4LockedTool(props.approval?.tool),
);
const title = computed(() =>
  isTerminalApproval.value
    ? "Security Alert: Agent requests Terminal execution."
    : "Security Alert: Agent requests tool execution.",
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="approval"
      class="approval-modal-backdrop"
      role="presentation"
    >
      <section
        class="approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-modal-title"
      >
        <div class="approval-modal-icon" aria-hidden="true">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
        </div>

        <div class="approval-modal-body">
          <p class="approval-modal-kicker">L4_Locked</p>
          <h2 id="approval-modal-title">{{ title }}</h2>
          <p class="approval-modal-description">{{ description }}</p>

          <div class="approval-command-box">
            <span>Command arguments</span>
            <pre>{{ command }}</pre>
          </div>

          <div class="approval-modal-actions">
            <NButton
              size="large"
              secondary
              @click="emit('reject')"
            >
              Reject
            </NButton>
            <NButton
              size="large"
              type="error"
              @click="emit('approve')"
            >
              Approve
            </NButton>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.approval-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 50% 0%, rgba(248, 113, 113, 0.18), transparent 38%),
    rgba(10, 10, 12, 0.58);
  backdrop-filter: blur(18px);
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
}

.approval-modal {
  width: min(560px, 100%);
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 16px;
  padding: 18px;
  border: 1px solid rgba(248, 113, 113, 0.42);
  border-radius: 8px;
  color: #fff7f7;
  background:
    linear-gradient(180deg, rgba(127, 29, 29, 0.82), rgba(30, 10, 12, 0.88)),
    rgba(20, 8, 10, 0.88);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
}

.approval-modal-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  color: #fecaca;
  background: rgba(248, 113, 113, 0.16);
  border: 1px solid rgba(254, 202, 202, 0.24);
  border-radius: 8px;
}

.approval-modal-body {
  min-width: 0;
}

.approval-modal-kicker {
  margin: 0 0 6px;
  color: #fecaca;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: 0;
  text-transform: uppercase;
}

.approval-modal h2 {
  margin: 0;
  color: #fff;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 800;
}

.approval-modal-description {
  margin: 10px 0 0;
  color: rgba(255, 247, 247, 0.78);
  font-size: 13px;
  line-height: 1.5;
}

.approval-command-box {
  margin-top: 16px;
  border: 1px solid rgba(254, 202, 202, 0.22);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(17, 8, 10, 0.74);
}

.approval-command-box span {
  display: block;
  padding: 9px 12px;
  color: #fecaca;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  border-bottom: 1px solid rgba(254, 202, 202, 0.16);
}

.approval-command-box pre {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 12px;
  color: #fff;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.approval-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.approval-modal-actions :deep(.n-button) {
  min-width: 112px;
}

@media (max-width: 520px) {
  .approval-modal-backdrop {
    align-items: end;
    padding: 12px;
  }

  .approval-modal {
    grid-template-columns: 1fr;
    gap: 12px;
    padding: 14px;
  }

  .approval-modal-icon {
    width: 40px;
    height: 40px;
  }

  .approval-modal-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .approval-modal-actions :deep(.n-button) {
    min-width: 0;
  }
}
</style>
