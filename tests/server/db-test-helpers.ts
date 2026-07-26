import type { DatabaseSync } from 'node:sqlite'

export async function claimTestHermesDbOwnership(database: DatabaseSync): Promise<void> {
  const ownership = await import('../../packages/server/src/db/ownership')
  const row = database.prepare('PRAGMA database_list').get() as { file?: string } | undefined
  const path = String(row?.file || '')
  if (!path || path === ':memory:' || path.startsWith('file::memory:') || path.includes('mode=memory')) {
    ownership.claimHermesDatabaseOwnershipForTesting(database)
    return
  }
  ownership.acquireHermesDatabaseOwnership(database, path)
}
