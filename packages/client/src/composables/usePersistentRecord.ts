import { reactive } from 'vue'

export function usePersistentRecord(key: string) {
  let initial: Record<string, boolean> = {}

  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) initial = JSON.parse(raw)
    } catch {
      initial = {}
    }
  }

  const record = reactive<Record<string, boolean>>({ ...initial })

  function persist() {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, JSON.stringify({ ...record }))
  }

  return { record, persist }
}
