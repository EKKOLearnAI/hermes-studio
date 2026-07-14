import { afterEach, describe, expect, it, vi } from 'vitest'

let db: import('node:sqlite').DatabaseSync | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('../../packages/server/src/db/index')
  vi.resetModules()
})

describe('workflow edge evidence schema migration', () => {
  it('recreates canonical indexes on the replacement table after archiving a legacy table', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE workflow_run_edge_evaluations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE INDEX idx_workflow_run_edge_evaluations_run_sequence
        ON workflow_run_edge_evaluations(run_id, sequence);
      CREATE INDEX idx_workflow_run_edge_evaluations_edge
        ON workflow_run_edge_evaluations(edge_id);
      INSERT INTO workflow_run_edge_evaluations(id, run_id, edge_id, sequence)
        VALUES ('legacy-edge', 'legacy-run', 'legacy-route', 1);
    `)
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    const indexNames = (table: string) => (db!.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>)
      .map(row => row.name)
      .filter(name => !name.startsWith('sqlite_autoindex_'))
      .sort()
    expect(indexNames('workflow_run_edge_evaluations')).toEqual([
      'idx_workflow_run_edge_evaluations_edge',
      'idx_workflow_run_edge_evaluations_run_sequence',
    ])
    expect(indexNames('workflow_run_edge_evaluations__legacy_v1')).toEqual([])
    expect(db.prepare('SELECT id FROM workflow_run_edge_evaluations__legacy_v1').get()).toEqual({ id: 'legacy-edge' })

    expect(() => initAllHermesTables()).not.toThrow()
    expect(indexNames('workflow_run_edge_evaluations')).toEqual([
      'idx_workflow_run_edge_evaluations_edge',
      'idx_workflow_run_edge_evaluations_run_sequence',
    ])
  })
})
