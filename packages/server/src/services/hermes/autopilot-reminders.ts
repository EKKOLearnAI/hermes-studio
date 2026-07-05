import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getProfileDir } from './hermes-profile'
import { getPersonalAutopilotOverview, type AutopilotMode } from './personal-autopilot'
import { sendWeixinTextReminder } from './weixin-sender'

export type ReminderChannel = 'weixin'
export type ReminderDeliveryStatus = 'sent' | 'skipped' | 'failed'
export type ReminderSkipReason =
  | 'disabled'
  | 'quiet_hours'
  | 'duplicate_action'
  | 'daily_limit'
  | 'minimum_interval'
  | 'silent_mode'
  | 'send'

export interface ReminderSettings {
  profile: string
  enabled: boolean
  channel: ReminderChannel
  dailyLimit: number
  minimumIntervalMinutes: number
  quietStart: string
  quietEnd: string
  createdAt: string | null
  updatedAt: string | null
}

export interface ReminderDelivery {
  id: string
  profile: string
  channel: ReminderChannel
  mode: AutopilotMode | string
  actionId: string | null
  actionTitle: string
  message: string
  status: ReminderDeliveryStatus
  error: string | null
  sentAt: string
  createdAt: string
}

export interface ReminderPolicyDecision {
  shouldSend: boolean
  reason: ReminderSkipReason
}

export interface ReminderDispatchResult {
  status: ReminderDeliveryStatus
  reason: string
  delivery: ReminderDelivery
}

interface ReminderSettingsRow {
  profile: string
  enabled: number
  channel: ReminderChannel
  daily_limit: number
  minimum_interval_minutes: number
  quiet_start: string
  quiet_end: string
  created_at: string
  updated_at: string
}

interface ReminderDeliveryRow {
  id: string
  profile: string
  channel: ReminderChannel
  mode: string
  action_id: string | null
  action_title: string
  message: string
  status: ReminderDeliveryStatus
  error: string | null
  sent_at: string
  created_at: string
}

const DEFAULT_QUIET_START = '23:30'
const DEFAULT_QUIET_END = '08:00'

function id(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function profileName(profile?: string | null): string {
  return profile?.trim() || 'default'
}

function openAutopilotReminderDb(profile?: string): DatabaseSync {
  const dbPath = getAutopilotReminderDbPath(profile)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  initAutopilotReminderDb(db)
  return db
}

export function defaultReminderSettings(profile?: string): ReminderSettings {
  return {
    profile: profileName(profile),
    enabled: false,
    channel: 'weixin',
    dailyLimit: 5,
    minimumIntervalMinutes: 60,
    quietStart: DEFAULT_QUIET_START,
    quietEnd: DEFAULT_QUIET_END,
    createdAt: null,
    updatedAt: null,
  }
}

export function getAutopilotReminderDbPath(profile?: string): string {
  return join(getProfileDir(profileName(profile)), 'autopilot_reminders.db')
}

export function initAutopilotReminderDb(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_reminder_settings (
      profile TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      channel TEXT NOT NULL,
      daily_limit INTEGER NOT NULL,
      minimum_interval_minutes INTEGER NOT NULL,
      quiet_start TEXT NOT NULL,
      quiet_end TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS autopilot_reminder_deliveries (
      id TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      channel TEXT NOT NULL,
      mode TEXT NOT NULL,
      action_id TEXT,
      action_title TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

export function getReminderSettings(profile?: string): ReminderSettings {
  const name = profileName(profile)
  const db = openAutopilotReminderDb(name)
  try {
    const row = db.prepare('SELECT * FROM autopilot_reminder_settings WHERE profile = ?').get(name) as ReminderSettingsRow | undefined
    return row ? settingsFromRow(row) : defaultReminderSettings(name)
  } finally {
    db.close()
  }
}

export function updateReminderSettings(profile: string, patch: Partial<ReminderSettings>): ReminderSettings {
  const name = profileName(profile)
  const current = getReminderSettings(name)
  const updatedAt = nowIso()
  const next: ReminderSettings = {
    ...current,
    ...patch,
    profile: name,
    channel: 'weixin',
    createdAt: current.createdAt || updatedAt,
    updatedAt,
  }
  const db = openAutopilotReminderDb(name)
  try {
    db.prepare(`
      INSERT INTO autopilot_reminder_settings (
        profile, enabled, channel, daily_limit, minimum_interval_minutes, quiet_start, quiet_end, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile) DO UPDATE SET
        enabled=excluded.enabled,
        channel=excluded.channel,
        daily_limit=excluded.daily_limit,
        minimum_interval_minutes=excluded.minimum_interval_minutes,
        quiet_start=excluded.quiet_start,
        quiet_end=excluded.quiet_end,
        updated_at=excluded.updated_at
    `).run(
      name,
      next.enabled ? 1 : 0,
      next.channel,
      next.dailyLimit,
      next.minimumIntervalMinutes,
      next.quietStart,
      next.quietEnd,
      next.createdAt,
      next.updatedAt,
    )
  } finally {
    db.close()
  }
  return getReminderSettings(name)
}

export function listRecentReminderDeliveries(profile: string, limit = 20): ReminderDelivery[] {
  const name = profileName(profile)
  const db = openAutopilotReminderDb(name)
  try {
    const rows = db.prepare(`
      SELECT * FROM autopilot_reminder_deliveries
      WHERE profile = ?
      ORDER BY sent_at DESC, created_at DESC
      LIMIT ?
    `).all(name, Math.max(1, Math.min(100, Math.floor(limit)))) as unknown as ReminderDeliveryRow[]
    return rows.map(deliveryFromRow)
  } finally {
    db.close()
  }
}

export function recordReminderDelivery(
  profile: string,
  delivery: Partial<Omit<ReminderDelivery, 'profile' | 'createdAt'>> & {
    channel: ReminderChannel
    mode: AutopilotMode | string
    actionTitle: string
    message: string
    status: ReminderDeliveryStatus
  },
): ReminderDelivery {
  const name = profileName(profile)
  const createdAt = nowIso()
  const row: ReminderDelivery = {
    id: delivery.id || id('autopilot-reminder'),
    profile: name,
    channel: delivery.channel,
    mode: delivery.mode,
    actionId: delivery.actionId || null,
    actionTitle: delivery.actionTitle,
    message: delivery.message,
    status: delivery.status,
    error: delivery.error || null,
    sentAt: delivery.sentAt || createdAt,
    createdAt,
  }
  const db = openAutopilotReminderDb(name)
  try {
    db.prepare(`
      INSERT INTO autopilot_reminder_deliveries (
        id, profile, channel, mode, action_id, action_title, message, status, error, sent_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.profile,
      row.channel,
      row.mode,
      row.actionId,
      row.actionTitle,
      row.message,
      row.status,
      row.error,
      row.sentAt,
      row.createdAt,
    )
  } finally {
    db.close()
  }
  return row
}

export async function dispatchAutopilotReminder(options: {
  profile?: string
  now?: Date
  force?: boolean
} = {}): Promise<ReminderDispatchResult> {
  const profile = profileName(options.profile)
  const now = options.now || new Date()
  const settings = getReminderSettings(profile)
  const autopilot = getPersonalAutopilotOverview({ profile })
  const action = autopilot.nextAction
  const deliveriesToday = listRecentReminderDeliveries(profile, 100)
    .filter(delivery => sameLocalDate(new Date(delivery.sentAt), now))
  const decision = options.force
    ? { shouldSend: true, reason: 'send' as ReminderSkipReason }
    : evaluateReminderPolicy({ now, settings, autopilot, deliveriesToday })
  const message = formatAutopilotReminderMessage(action)

  if (!decision.shouldSend) {
    const delivery = recordReminderDelivery(profile, {
      channel: settings.channel,
      mode: autopilot.mode,
      actionId: action.id,
      actionTitle: action.title,
      message,
      status: 'skipped',
      error: decision.reason,
      sentAt: now.toISOString(),
    })
    return { status: 'skipped', reason: decision.reason, delivery }
  }

  const sendResult = await sendWeixinTextReminder(profile, message)
  if (!sendResult.ok) {
    const reason = sendResult.error || 'weixin_send_failed'
    const delivery = recordReminderDelivery(profile, {
      channel: settings.channel,
      mode: autopilot.mode,
      actionId: action.id,
      actionTitle: action.title,
      message,
      status: 'failed',
      error: reason,
      sentAt: now.toISOString(),
    })
    return { status: 'failed', reason, delivery }
  }

  const delivery = recordReminderDelivery(profile, {
    channel: settings.channel,
    mode: autopilot.mode,
    actionId: action.id,
    actionTitle: action.title,
    message,
    status: 'sent',
    sentAt: now.toISOString(),
  })
  return { status: 'sent', reason: decision.reason, delivery }
}

export function evaluateReminderPolicy(input: {
  now?: Date
  settings: ReminderSettings
  autopilot: {
    mode: AutopilotMode | string
    nextAction: { id: string; title: string; reason: string; fallbackTitle: string }
  }
  deliveriesToday: ReminderDelivery[]
}): ReminderPolicyDecision {
  const now = input.now || new Date()
  const sentToday = input.deliveriesToday.filter(delivery => delivery.status === 'sent')
  if (!input.settings.enabled) return { shouldSend: false, reason: 'disabled' }
  if (input.autopilot.mode === 'silent') return { shouldSend: false, reason: 'silent_mode' }
  if (isQuietTime(now, input.settings.quietStart, input.settings.quietEnd)) return { shouldSend: false, reason: 'quiet_hours' }
  if (sentToday.some(delivery => delivery.actionId === input.autopilot.nextAction.id)) {
    return { shouldSend: false, reason: 'duplicate_action' }
  }
  if (sentToday.length >= input.settings.dailyLimit) return { shouldSend: false, reason: 'daily_limit' }

  const latestSent = sentToday
    .map(delivery => new Date(delivery.sentAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]
  if (latestSent && now.getTime() - latestSent < input.settings.minimumIntervalMinutes * 60_000) {
    return { shouldSend: false, reason: 'minimum_interval' }
  }
  return { shouldSend: true, reason: 'send' }
}

export function formatAutopilotReminderMessage(action: { title: string; reason: string; fallbackTitle: string }): string {
  return `现在最该做：${action.title}\n原因：${action.reason}\n保底：${action.fallbackTitle}`
}

function settingsFromRow(row: ReminderSettingsRow): ReminderSettings {
  return {
    profile: row.profile,
    enabled: row.enabled === 1,
    channel: row.channel,
    dailyLimit: row.daily_limit,
    minimumIntervalMinutes: row.minimum_interval_minutes,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deliveryFromRow(row: ReminderDeliveryRow): ReminderDelivery {
  return {
    id: row.id,
    profile: row.profile,
    channel: row.channel,
    mode: row.mode,
    actionId: row.action_id,
    actionTitle: row.action_title,
    message: row.message,
    status: row.status,
    error: row.error,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  }
}

function isQuietTime(now: Date, quietStart: string, quietEnd: string): boolean {
  const minute = now.getHours() * 60 + now.getMinutes()
  const start = minuteOfDay(quietStart)
  const end = minuteOfDay(quietEnd)
  if (start === end) return false
  if (start < end) return minute >= start && minute < end
  return minute >= start || minute < end
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(part => Number.parseInt(part, 10))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return Math.max(0, Math.min(23, hour)) * 60 + Math.max(0, Math.min(59, minute))
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}
