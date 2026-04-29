/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 */

export async function initAllStores(): Promise<void> {
  const { initUsageStore } = await import('./usage-store')
  initUsageStore()

  const { initSessionStore } = await import('./session-store')
  initSessionStore()

  const { initCompressionSnapshotStore } = await import('./compression-snapshot')
  initCompressionSnapshotStore()
}
