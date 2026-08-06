/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 *
 * All table schemas, creation, and migration logic are now centralized
 * in schemas.ts to avoid duplication and ensure consistency.
 */

import { initAllHermesTables } from './schemas'
import { pruneChatRunInvocations, recoverOrphanedChatRunInvocations } from './chat-run-invocation-store'

const CHAT_RUN_INVOCATION_RETENTION_SECONDS = 7 * 24 * 60 * 60

export function initAllStores(): void {
  // Initialize all tables with centralized schema definitions and migrations
  initAllHermesTables()
  recoverOrphanedChatRunInvocations()
  pruneChatRunInvocations(Math.floor(Date.now() / 1000) - CHAT_RUN_INVOCATION_RETENTION_SECONDS)
}
