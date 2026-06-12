<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '@/composables/useTheme'

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: false })
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()
const { isDark } = useTheme()
const terminalEl = ref<HTMLDivElement>()
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
const isDesktop = !!(window as any).hermesDesktop?.isDesktop

function initTerminal() {
  if (!terminalEl.value) return
  fitAddon = new FitAddon()
  term = new Terminal({
    cursorBlink: true, cursorStyle: 'block', fontSize: 13,
    fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
    theme: isDark.value ? {
      background: '#1a1b1e', foreground: '#d4d4d8', cursor: '#e4e4e7',
      black: '#1a1b1e', red: '#f43f5e', green: '#22c55e', yellow: '#eab308',
      blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#d4d4d8',
    } : {
      background: '#ffffff', foreground: '#18181b', cursor: '#18181b',
    },
  })
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(terminalEl.value)
  fitAddon.fit()
  term.writeln('Hermes Studio Terminal')
  term.writeln('')

  if (isDesktop) {
    const desktop = (window as any).hermesDesktop
    term.onData((data: string) => desktop?.writeToTerminal?.(data))
    term.write('$ ')
  } else {
    term.writeln('WebSocket mode - desktop recommended')
  }
}

onMounted(() => nextTick(() => initTerminal()))
onUnmounted(() => { term?.dispose(); term = null; fitAddon = null })
</script>

<template>
  <div v-show="visible" class="terminal-panel" :class="{ dark: isDark }">
    <div class="terminal-header">
      <span class="terminal-title">Terminal</span>
      <button class="action-btn" @click="emit('update:visible', false)">Close</button>
    </div>
    <div ref="terminalEl" class="terminal-body" />
  </div>
</template>

<style scoped lang="scss">
.terminal-panel {
  flex-shrink: 0; border-top: 1px solid #e4e4e7;
  display: flex; flex-direction: column; height: 240px; background-color: #1a1b1e;
}
.terminal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 12px; background-color: #27272a; flex-shrink: 0;
}
.terminal-title { font-size: 12px; color: #a1a1aa; font-weight: 500; }
.action-btn {
  background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 12px;
  &:hover { background-color: #3f3f46; color: #e4e4e7; }
}
.terminal-body { flex: 1; overflow: hidden; padding: 4px; }
</style>
