import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getProfileDir } from './hermes/hermes-profile'
import {
  createNotification,
  type CreateNotificationInput,
  type NotificationRecord,
} from '../db/hermes/notification-store'

export interface PublishedNotification {
  ownerId: number
  profile: string
  notification: NotificationRecord
}

type Listener = (event: PublishedNotification) => void

class NotificationService extends EventEmitter {
  publish(input: CreateNotificationInput) {
    const result = createNotification(input)
    if (result.created) {
      this.emit('created', {
        ownerId: input.ownerId,
        profile: input.profile,
        notification: result.notification,
      } satisfies PublishedNotification)
    }
    return result
  }

  onCreated(listener: Listener): () => void {
    this.on('created', listener)
    return () => this.off('created', listener)
  }
}

export const notificationService = new NotificationService()

interface CronMetadata {
  id?: string
  job_id?: string
  name?: string
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
}

function cronJobs(profile: string): CronMetadata[] {
  const file = join(getProfileDir(profile), 'cron', 'jobs.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CronMetadata[] | { jobs?: CronMetadata[] }
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : []
  } catch { return [] }
}

export function reconcileCronNotifications(ownerId: number, profile: string): number {
  let created = 0
  for (const job of cronJobs(profile)) {
    const id = String(job.job_id || job.id || '').trim()
    const ranAt = String(job.last_run_at || '').trim()
    if (!id || !ranAt) continue
    const failed = ['failed', 'error'].includes(String(job.last_status || '').toLowerCase()) || Boolean(job.last_error)
    const result = notificationService.publish({
      ownerId,
      profile,
      dedupeKey: `cron:${id}:${ranAt}:${failed ? 'failed' : 'completed'}`,
      type: failed ? 'cron.failed' : 'cron.completed',
      severity: failed ? 'error' : 'success',
      title: String(job.name || id),
      body: failed ? String(job.last_error || 'Cron job failed') : 'Cron job completed',
      source: {
        kind: 'cron', id,
        route: { name: 'hermes.jobs', query: { jobId: id } },
      },
    })
    if (result.created) created += 1
  }
  return created
}
