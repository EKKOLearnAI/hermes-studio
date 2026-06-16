<script setup lang="ts">
import { ref } from "vue";

export interface ConversationNavItem {
  id: string
  messageId: string
  index: number
  label: string
}

const props = defineProps<{
  items: ConversationNavItem[]
  activeId?: string | null
  label: string
}>()

const emit = defineEmits<{
  navigate: [messageId: string]
}>()

const hoveredItem = ref<ConversationNavItem | null>(null);
const tooltipTop = ref(0);

function isActive(item: ConversationNavItem): boolean {
  return props.activeId === item.id
}

function showTooltip(item: ConversationNavItem, event: MouseEvent | FocusEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const nav = target.closest<HTMLElement>(".conversation-navigator");
  if (!nav) return;

  const targetRect = target.getBoundingClientRect();
  const navRect = nav.getBoundingClientRect();
  hoveredItem.value = item;
  tooltipTop.value = targetRect.top - navRect.top + targetRect.height / 2;
}

function hideTooltip(item: ConversationNavItem) {
  if (hoveredItem.value?.id === item.id) hoveredItem.value = null;
}
</script>

<template>
  <nav
    v-if="items.length > 0"
    class="conversation-navigator"
    :aria-label="label"
    data-testid="conversation-navigator"
  >
    <div class="conversation-nav-rail" role="presentation">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="conversation-nav-dot"
        :class="{ active: isActive(item) }"
        :aria-label="item.label"
        :aria-current="isActive(item) ? 'true' : undefined"
        @mouseenter="showTooltip(item, $event)"
        @mouseleave="hideTooltip(item)"
        @focus="showTooltip(item, $event)"
        @blur="hideTooltip(item)"
        @click="emit('navigate', item.messageId)"
      >
        <span class="conversation-nav-dot-bar" aria-hidden="true"></span>
      </button>
    </div>
    <span
      v-if="hoveredItem"
      class="conversation-nav-tooltip"
      role="tooltip"
      :style="{ top: `${tooltipTop}px` }"
    >{{ hoveredItem.label }}</span>
  </nav>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.conversation-navigator {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  width: 48px;
  max-width: 48px;
  overflow: visible;
  pointer-events: none;
}

.conversation-nav-rail {
  width: 48px;
  max-height: min(70vh, 520px);
  padding: 5px 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  pointer-events: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.conversation-nav-dot {
  position: relative;
  width: 40px;
  height: 15px;
  padding: 0 3px;
  border: none;
  border-radius: 999px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.72;
  transition:
    opacity 90ms ease,
    background-color 90ms ease,
    transform 90ms ease;

  &:hover,
  &:focus-visible {
    opacity: 1;
    transform: translateX(-2px);
    background: rgba(255, 255, 255, 0.11);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
    outline: none;

    .conversation-nav-dot-bar {
      width: 30px;
      background: $text-secondary;
    }
  }

  &.active {
    opacity: 1;

    .conversation-nav-dot-bar {
      width: 34px;
      background: $text-primary;
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.12);
    }
  }
}

.conversation-nav-dot-bar {
  width: 25px;
  height: 3px;
  border-radius: 999px;
  background: $text-muted;
  transition: width 90ms ease, background-color 90ms ease;

  .dark & {
    background: rgba(255, 255, 255, 0.42);
  }
}

.conversation-nav-tooltip {
  position: absolute;
  right: calc(100% + 8px);
  transform: translateY(-50%);
  width: max-content;
  max-width: min(360px, calc(100vw - 112px));
  padding: 7px 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.96);
  color: $text-primary;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  pointer-events: none;

  .dark & {
    background: rgba(28, 28, 28, 0.96);
    border-color: rgba(255, 255, 255, 0.12);
  }
}

.dark .conversation-nav-dot:hover,
.dark .conversation-nav-dot:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}

.dark .conversation-nav-dot.active .conversation-nav-dot-bar {
  background: rgba(255, 255, 255, 0.95);
}

@media (max-width: 640px) {
  .conversation-navigator {
    right: 4px;
    width: 36px;
    max-width: 36px;
  }

  .conversation-nav-rail {
    width: 36px;
    padding: 4px 3px;
    gap: 6px;
  }

  .conversation-nav-dot {
    width: 30px;
    height: 13px;
  }

  .conversation-nav-dot-bar {
    width: 20px;
  }

  .conversation-nav-dot.active .conversation-nav-dot-bar {
    width: 26px;
  }

  .conversation-nav-tooltip {
    max-width: min(280px, calc(100vw - 80px));
  }
}
</style>
