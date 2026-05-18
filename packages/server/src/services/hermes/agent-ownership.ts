/**
 * US-07 ownership: a Feishu user may only attach profiles they own.
 * Older multitenancy DBs may lack owner_open_id/provenance, so ownership
 * detection must drop missing-column predicates instead of throwing.
 */

import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../../config'

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function candidateMultitenancyDbs(): string[] {
    const configured = config.multitenancyDb
    const base = resolve(homedir(), '.hermes')
    return Array.from(new Set([
        configured,
        resolve(base, 'multitenancy.db'),
        resolve(base, 'multitenancy_routing.db'),
    ].filter(isNonEmptyString)))
}

export function ownerOwnsProfile(openid: string, profileName: string): boolean {
    if (!isNonEmptyString(openid) || !isNonEmptyString(profileName)) return false

    const normalizedOpenid = openid.trim()
    const normalizedProfileName = profileName.trim()

    for (const dbPath of candidateMultitenancyDbs()) {
        try {
            if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
                const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
                const disjuncts: string[] = []
                const params: string[] = [normalizedProfileName]

                if (columns.has('owner_open_id')) {
                    disjuncts.push('owner_open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (columns.has('provenance')) {
                    disjuncts.push("(open_id = ? AND provenance = 'sync')")
                    params.push(normalizedOpenid)
                } else {
                    disjuncts.push('open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (disjuncts.length === 0) return false

                const row = db.prepare(
                    `SELECT 1
                     FROM multitenancy_routing
                     WHERE profile_name = ?
                       AND active = 1
                       AND (${disjuncts.join(' OR ')})
                     LIMIT 1`
                ).get(...params)

                if (row) return true
            } finally {
                db.close()
            }
        } catch {
            // Try the next candidate DB.
        }
    }

    return false
}
