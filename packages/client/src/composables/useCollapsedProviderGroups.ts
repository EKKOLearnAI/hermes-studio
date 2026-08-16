import { usePersistentRecord } from './usePersistentRecord'

/**
 * Which provider groups the user has collapsed in the model pickers.
 *
 * Every picker reset this on open, so someone with forty providers folded the
 * same groups away again on every visit. One record is shared by all the
 * pickers on purpose — a provider you have folded away stays folded wherever
 * you meet it — and it is created once at module scope so two open pickers
 * cannot write over each other's state.
 */

const { record, persist } = usePersistentRecord('hermes.models.collapsedProviderGroups')

export function useCollapsedProviderGroups() {
  function isGroupCollapsed(provider: string): boolean {
    return !!record[provider]
  }

  function toggleGroup(provider: string) {
    // Keep only what is collapsed, so the record cannot grow forever with
    // every provider the user has ever expanded.
    if (record[provider]) delete record[provider]
    else record[provider] = true
    persist()
  }

  return { isGroupCollapsed, toggleGroup }
}
