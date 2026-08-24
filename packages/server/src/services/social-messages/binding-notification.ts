import {
  getSocialMessageAccount,
  markSocialMessageBindingNotified,
  normalizeSocialMessageBindingLocale,
  setSocialMessageAccountTarget,
  type SocialMessageBindingLocale,
} from '../../db/hermes/social-message-store'
import { logger } from '../logger'
import { getSocialMessageService } from './service'
import type { SocialMessagePlatform, SocialMessageRecipientType } from './types'

const BINDING_SUCCESS_MESSAGES: Record<SocialMessageBindingLocale, string> = {
  zh: '✅ 通知绑定成功',
  'zh-TW': '✅ 通知綁定成功',
  en: '✅ Notification binding successful',
  ja: '✅ 通知の連携に成功しました',
  ko: '✅ 알림 연결에 성공했습니다',
  fr: '✅ Liaison des notifications réussie',
  es: '✅ Vinculación de notificaciones completada',
  de: '✅ Benachrichtigungen erfolgreich verknüpft',
  pt: '✅ Vinculação de notificações concluída',
  ru: '✅ Уведомления успешно привязаны',
  ar: '✅ تم ربط الإشعارات بنجاح',
}

export interface FirstBindingNotificationInput {
  userId: number
  platform: SocialMessagePlatform
  recipient: string
  recipientType: SocialMessageRecipientType
  contextToken?: string
}

const notificationTasks = new Map<string, Promise<boolean>>()

export function formatBindingSuccessMessage(locale: unknown): string {
  return BINDING_SUCCESS_MESSAGES[normalizeSocialMessageBindingLocale(locale)]
}

async function sendFirstBindingNotification(input: FirstBindingNotificationInput): Promise<boolean> {
  const account = getSocialMessageAccount(input.userId, input.platform)
  if (!account || account.bindingNotified) return false
  const recipient = input.recipient.trim()
  if (!recipient) return false

  const targetSaved = setSocialMessageAccountTarget({
    userId: input.userId,
    platform: input.platform,
    recipient,
    recipientType: input.recipientType,
    active: true,
  })
  if (!targetSaved) return false

  try {
    await getSocialMessageService().send(input.userId, {
      platform: input.platform,
      recipient,
      recipientType: input.recipientType,
      content: formatBindingSuccessMessage(account.bindingLocale),
      ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    })
    return markSocialMessageBindingNotified(input.userId, input.platform)
  } catch (error) {
    logger.warn({
      error,
      userId: input.userId,
      platform: input.platform,
      recipient,
    }, '[social-messages] failed to send first binding notification')
    return false
  }
}

export async function notifyFirstSocialMessageBinding(
  input: FirstBindingNotificationInput,
): Promise<boolean> {
  const key = `${input.userId}:${input.platform}`
  const existing = notificationTasks.get(key)
  if (existing) return existing
  const task = sendFirstBindingNotification(input).finally(() => {
    if (notificationTasks.get(key) === task) notificationTasks.delete(key)
  })
  notificationTasks.set(key, task)
  return task
}
