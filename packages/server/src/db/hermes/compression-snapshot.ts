/**
 * SQLite-backed compression snapshot store for 1:1 chat sessions.
 *
 * Stores the latest compression summary and the index of the last
 * compressed message, so incremental compression can pick up where
 * the previous one left off.
 */

import { isSqliteAvailable, getDb } from '../index'
import { COMPRESSION_SNAPSHOT_TABLE as TABLE } from './schemas'

export function getCompressionSnapshot(sessionId: string): { summary: string; lastMessageIndex: number; messageCountAtTime: number } | null {
  if (!isSqliteAvailable()) return null
  return getDb()!.prepare(
    `SELECT summary, last_message_index AS lastMessageIndex, message_count_at_time AS messageCountAtTime FROM ${TABLE} WHERE session_id = ?`,
  ).get(sessionId) as any ?? null
}

export function saveCompressionSnapshot(
  sessionId: string,
  summary: string,
  lastMessageIndex: number,
  messageCountAtTime: number,
): void {
  if (!isSqliteAvailable()) return
  getDb()!.prepare(
    `INSERT INTO ${TABLE} (session_id, summary, last_message_index, message_count_at_time, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       summary = excluded.summary,
       last_message_index = excluded.last_message_index,
       message_count_at_time = excluded.message_count_at_time,
       updated_at = excluded.updated_at`,
  ).run(sessionId, summary, lastMessageIndex, messageCountAtTime, Date.now())
}

export function deleteCompressionSnapshot(sessionId: string): void {
  if (!isSqliteAvailable()) return
  getDb()!.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId)
}
