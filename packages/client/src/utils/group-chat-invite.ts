const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const GROUP_CHAT_INVITE_CODE_LENGTH = 16

export function generateGroupChatInviteCode(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Secure random number generation is unavailable')
  }
  const random = new Uint8Array(GROUP_CHAT_INVITE_CODE_LENGTH)
  cryptoApi.getRandomValues(random)
  return Array.from(random, (value) => INVITE_CODE_ALPHABET[value & 31]).join('')
}

export function groupChatInviteCodeForCreate(explicitCode: string): string {
  return explicitCode === '' ? generateGroupChatInviteCode() : explicitCode
}

export function groupChatInviteCodeForClone(explicitCode: string): string | undefined {
  return explicitCode === '' ? undefined : explicitCode
}
