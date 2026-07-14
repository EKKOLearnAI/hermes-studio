import { DatabaseSync } from 'node:sqlite'
import { withPersonalTwinDb } from '../personal-twin/database'

/** Database boundary for Home Twin operations. Write APIs are added in Task 2. */
export class HomeTwinStore {
  constructor(readonly database: DatabaseSync) {}
}

export function withHomeTwinStore<T>(operation: (store: HomeTwinStore) => T): T {
  return withPersonalTwinDb(database => operation(new HomeTwinStore(database)))
}
