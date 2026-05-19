import { ref } from 'vue'

const STORAGE_KEY = 'hermes_show_tool_calls'

function readInitialValue(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

const toolTraceVisible = ref(readInitialValue())

function setToolTraceVisible(value: boolean) {
  toolTraceVisible.value = value
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // Ignore storage failures; the in-memory toggle still works for this tab.
  }
}

function toggleToolTraceVisible() {
  setToolTraceVisible(!toolTraceVisible.value)
}

export function useToolTraceVisibility() {
  return {
    toolTraceVisible,
    setToolTraceVisible,
    toggleToolTraceVisible,
  }
}
