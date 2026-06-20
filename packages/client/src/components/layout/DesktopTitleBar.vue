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
const platform = desktop?.platform
const isMac = computed(() => platform === 'darwin')
const showTitleBar = computed(() => platform === 'darwin' || platform === 'win32')
const showWindowButtons = computed(() => platform === 'win32')
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
  <header v-if="showTitleBar" class="desktop-titlebar" :class="{ mac: isMac }" @dblclick="controlWindow('toggle-maximize')">
    <div class="desktop-titlebar__drag">
      <div class="desktop-titlebar__brand">
        <img class="desktop-titlebar__logo" src="/logo.png" alt="" draggable="false">
        <span class="desktop-titlebar__title">Hermes Studio</span>
      </div>
    </div>
    <div v-if="showWindowButtons" class="desktop-titlebar__controls" @dblclick.stop>
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
  </header>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.desktop-titlebar {
  height: 36px;
  flex: 0 0 36px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid $border-color;
  background: $bg-sidebar;
  color: $text-primary;
  user-select: none;
  -webkit-app-region: drag;

  &.mac {
    padding-left: 82px;
  }
}

.desktop-titlebar__drag {
  min-width: 0;
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
}

.desktop-titlebar__brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 12px;
}

.desktop-titlebar__logo {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  object-fit: contain;
}

.desktop-titlebar__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}

.desktop-titlebar__controls {
  height: 100%;
  display: flex;
  align-items: stretch;
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
