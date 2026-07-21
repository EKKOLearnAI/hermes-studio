<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'

interface HermesDesktopBridge {
  platform?: string
  getWindowState?: () => Promise<{ isMaximized: boolean }>
  windowControl?: (action: WindowControlAction) => Promise<{ isMaximized: boolean }>
}

type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

const desktop = (window as WindowWithHermesDesktop).hermesDesktop
const props = defineProps<{
  standalone?: boolean
  leftOffset?: number
}>()
const showWindowButtons = computed(() => desktop?.platform === 'win32')
const titleBarStyle = computed(() => props.standalone ? undefined : { left: `${props.leftOffset ?? 260}px` })
const isMaximized = ref(false)

async function refreshWindowState() {
  if (!desktop?.getWindowState) return
  try {
    const state = await desktop.getWindowState()
    isMaximized.value = !!state.isMaximized
  } catch {
    /* ignore */
  }
}

async function controlWindow(action: WindowControlAction) {
  if (!desktop?.windowControl) return
  try {
    const state = await desktop.windowControl(action)
    isMaximized.value = !!state.isMaximized
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  void refreshWindowState()
})
</script>

<template>
  <div
    v-if="showWindowButtons"
    class="desktop-titlebar"
    :class="{ standalone }"
    :style="titleBarStyle"
    @dblclick="controlWindow('toggle-maximize')"
  >
    <div v-if="standalone" class="desktop-titlebar__standalone-drag" @dblclick="controlWindow('toggle-maximize')" />
    <div v-else class="desktop-titlebar__drag" />
    <div class="desktop-titlebar__controls" @dblclick.stop>
      <button class="desktop-window-btn" type="button" aria-label="Minimize" @click.stop="controlWindow('minimize')">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6.5h8" />
        </svg>
      </button>
      <button class="desktop-window-btn" type="button" :aria-label="isMaximized ? 'Restore' : 'Maximize'" @click.stop="controlWindow('toggle-maximize')">
        <svg v-if="isMaximized" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4 3.5h5v5H4z" />
          <path d="M3 7.5H2.5v-5h5V3" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 2.5h7v7h-7z" />
        </svg>
      </button>
      <button class="desktop-window-btn close" type="button" aria-label="Close" @click.stop="controlWindow('close')">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.desktop-titlebar {
  position: absolute;
  z-index: 1001;
  top: 10px;
  right: 10px;
  height: 36px;
  display: flex;
  align-items: center;
  border: 0;
  border-radius: 12px;
  background: $bg-main-surface;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  color: $text-primary;
  user-select: none;
  overflow: hidden;
  -webkit-app-region: drag;

  &::after {
    content: "";
    position: absolute;
    z-index: 2;
    inset: 0;
    border: 1px solid $border-color;
    border-radius: inherit;
    pointer-events: none;
  }

  &.standalone {
    left: auto;
    top: 10px;
    width: 138px;

    .desktop-titlebar__controls {
      border-left: 0;
    }
  }
}

.desktop-titlebar__drag {
  min-width: 0;
  flex: 1;
  height: 100%;
}

.desktop-titlebar__standalone-drag {
  position: fixed;
  z-index: 0;
  top: 0;
  left: 0;
  right: 138px;
  height: 46px;
  -webkit-app-region: drag;
}

.desktop-titlebar__controls {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  align-items: stretch;
  border-left: 1px solid $border-color;
  -webkit-app-region: no-drag;
}

.desktop-window-btn {
  width: 46px;
  height: 100%;
  border: 0;
  border-radius: 0;
  padding: 0;
  display: grid;
  place-items: center;
  color: $text-secondary;
  background: transparent;
  cursor: default;

  svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    color: $text-primary;
    background: rgba(var(--text-muted-rgb), 0.14);
  }

  &.close:hover {
    color: #ffffff;
    background: #c42b1c;
  }
}
</style>
