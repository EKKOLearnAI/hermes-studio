import { ref } from 'vue'

const sessionSearchOpen = ref(false)

export function useSessionSearch() {
  function openSessionSearch() {
    sessionSearchOpen.value = true
  }

  function closeSessionSearch() {
    sessionSearchOpen.value = false
  }

  return {
    sessionSearchOpen,
    openSessionSearch,
    closeSessionSearch,
  }
}
