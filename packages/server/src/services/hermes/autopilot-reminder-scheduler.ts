import { listProfileNamesFromDisk } from './hermes-profile'
import { enqueueAutopilotReminder, getReminderSettings } from './autopilot-reminders'
import { logger } from '../logger'

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

export interface AutopilotReminderScheduler {
  stop: () => void
}

export function startAutopilotReminderScheduler(): AutopilotReminderScheduler {
  if (process.env.HERMES_AUTOPILOT_REMINDERS_DISABLED === '1') {
    return { stop: () => {} }
  }

  const intervalMs = intervalFromEnv()
  const timer = setInterval(() => {
    void dispatchEnabledProfiles()
  }, intervalMs)

  return {
    stop: () => clearInterval(timer),
  }
}

async function dispatchEnabledProfiles(): Promise<void> {
  for (const profile of listProfileNamesFromDisk()) {
    try {
      if (!getReminderSettings(profile).enabled) continue
      await enqueueAutopilotReminder({ profile })
    } catch (err) {
      logger.warn(err, '[autopilot-reminders] dispatch failed profile=%s', profile)
    }
  }
}

function intervalFromEnv(): number {
  const value = Number.parseInt(process.env.HERMES_AUTOPILOT_REMINDER_INTERVAL_MS || '', 10)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS
}
