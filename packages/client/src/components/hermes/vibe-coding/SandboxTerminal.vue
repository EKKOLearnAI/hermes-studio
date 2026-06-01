<script setup lang="ts">
import type { SandboxLine } from '@/stores/hermes/vibe-coding'

defineProps<{
  lines: SandboxLine[]
}>()
</script>

<template>
  <section class="sandbox-terminal" aria-label="Sandbox terminal">
    <header class="sandbox-terminal-header">
      <div class="terminal-window-dots" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span class="terminal-title">SandboxTerminal</span>
      <span class="terminal-state">isolated</span>
    </header>

    <div class="sandbox-terminal-body">
      <div
        v-for="line in lines"
        :key="line.id"
        class="terminal-line"
        :class="[`is-${line.source}`, `tone-${line.tone}`]"
      >
        <span class="terminal-source">{{ line.source }}</span>
        <code>{{ line.text }}</code>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.sandbox-terminal {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(14, 20, 31, 0.18);
  border-radius: 8px;
  background: rgba(12, 16, 24, 0.92);
  box-shadow:
    0 12px 30px rgba(8, 12, 20, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.sandbox-terminal-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(237, 243, 255, 0.7);
}

.terminal-window-dots {
  display: inline-flex;
  gap: 5px;
}

.terminal-window-dots span {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(237, 243, 255, 0.28);
}

.terminal-window-dots span:nth-child(1) {
  background: #f87171;
}

.terminal-window-dots span:nth-child(2) {
  background: #facc15;
}

.terminal-window-dots span:nth-child(3) {
  background: #34d399;
}

.terminal-title {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-state {
  padding: 3px 7px;
  border: 1px solid rgba(52, 211, 153, 0.24);
  border-radius: 999px;
  color: #a7f3d0;
  background: rgba(52, 211, 153, 0.08);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.1;
}

.sandbox-terminal-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 132px;
  max-height: 210px;
  overflow: auto;
  padding: 9px 0;
}

.terminal-line {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 8px;
  padding: 2px 12px;
  color: rgba(237, 243, 255, 0.78);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.terminal-line code {
  min-width: 0;
  color: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.terminal-source {
  color: rgba(237, 243, 255, 0.38);
  font-weight: 800;
  text-transform: uppercase;
}

.tone-muted {
  color: rgba(237, 243, 255, 0.56);
}

.tone-info {
  color: #bae6fd;
}

.tone-success {
  color: #a7f3d0;
}

.tone-warning {
  color: #fde68a;
}

.tone-danger {
  color: #fecaca;
}
</style>
