/**
 * Standard 5-field cron parsing and next-run computation for the web-ui-owned
 * scheduler. Replaces the schedule semantics the Hermes CLI used to own.
 *
 * Field order: minute hour day-of-month month day-of-week.
 * Supported per-field syntax: `*`, `a`, `a-b`, `a,b,c`, `* / n` (step), `a-b/n`.
 * Day-of-week accepts 0-7 (both 0 and 7 mean Sunday).
 *
 * Matching uses the server's local time (matching classic cron). When both
 * day-of-month and day-of-week are restricted, a match occurs if EITHER field
 * matches (Vixie cron behavior).
 */

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

export interface CronSchedule {
  kind: 'cron'
  expr: string
  display: string
  fields: CronFields
}

export type ParsedSchedule = CronSchedule

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 7], // day-of-week (7 normalized to 0)
]

function parseTerm(term: string, min: number, max: number, set: Set<number>): void {
  let range = term
  let step = 1

  const slash = term.indexOf('/')
  if (slash !== -1) {
    range = term.slice(0, slash)
    const stepRaw = term.slice(slash + 1)
    step = Number(stepRaw)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid step in cron field: ${term}`)
  }

  let lo = min
  let hi = max
  if (range !== '*') {
    const dash = range.indexOf('-')
    if (dash !== -1) {
      lo = Number(range.slice(0, dash))
      hi = Number(range.slice(dash + 1))
    } else {
      lo = Number(range)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`Invalid cron field value: ${term}`)
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron field out of range: ${term}`)
  }

  for (let value = lo; value <= hi; value += step) {
    set.add(value)
  }
}

function parseField(spec: string, min: number, max: number): { set: Set<number>; restricted: boolean } {
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('Empty cron field')
  const set = new Set<number>()
  for (const term of trimmed.split(',')) {
    parseTerm(term.trim(), min, max, set)
  }
  if (set.size === 0) throw new Error(`Cron field matched nothing: ${spec}`)
  return { set, restricted: trimmed !== '*' }
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expr}"`)
  }

  const minute = parseField(parts[0], FIELD_BOUNDS[0][0], FIELD_BOUNDS[0][1])
  const hour = parseField(parts[1], FIELD_BOUNDS[1][0], FIELD_BOUNDS[1][1])
  const dom = parseField(parts[2], FIELD_BOUNDS[2][0], FIELD_BOUNDS[2][1])
  const month = parseField(parts[3], FIELD_BOUNDS[3][0], FIELD_BOUNDS[3][1])
  const dowRaw = parseField(parts[4], FIELD_BOUNDS[4][0], FIELD_BOUNDS[4][1])

  // Normalize day-of-week 7 -> 0 (both Sunday).
  const dow = new Set<number>()
  for (const value of dowRaw.set) dow.add(value === 7 ? 0 : value)

  return {
    minute: minute.set,
    hour: hour.set,
    dom: dom.set,
    month: month.set,
    dow,
    domRestricted: dom.restricted,
    dowRestricted: dowRaw.restricted,
  }
}

/** Whether `date` (local time) satisfies the cron fields. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false
  if (!fields.hour.has(date.getHours())) return false
  if (!fields.month.has(date.getMonth() + 1)) return false

  const domOk = fields.dom.has(date.getDate())
  const dowOk = fields.dow.has(date.getDay())

  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60

/** Next minute strictly after `from` that matches, or null within ~1 year. */
export function nextCronRun(fields: CronFields, from: Date): Date | null {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    if (cronMatches(fields, d)) return new Date(d.getTime())
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

/** Parse a schedule string (currently cron only). Throws on invalid input. */
export function parseSchedule(input: string): ParsedSchedule {
  const expr = input.trim()
  if (!expr) throw new Error('Schedule is required')
  const fields = parseCron(expr)
  return { kind: 'cron', expr, display: expr, fields }
}

/** Next fire time strictly after `from`, or null if none within the lookahead. */
export function nextRunAfter(schedule: ParsedSchedule, from: Date): Date | null {
  return nextCronRun(schedule.fields, from)
}
