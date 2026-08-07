const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const GROUP_CHAT_INVITE_CODE_LENGTH = 16

export function generateGroupChatInviteCode(): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(GROUP_CHAT_INVITE_CODE_LENGTH))
    return Array.from(bytes, byte => INVITE_CODE_ALPHABET[byte & 31]).join('')
}
