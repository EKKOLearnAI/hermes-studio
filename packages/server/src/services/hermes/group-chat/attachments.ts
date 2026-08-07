import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { config } from '../../../config'
import { isPathWithin } from '../hermes-path'

const MAX_GROUP_CHAT_ATTACHMENT_SIZE = 20 * 1024 * 1024
const MAX_GROUP_CHAT_CONTENT_BLOCKS = 32
const STORED_ATTACHMENT_NAME_PATTERN = /^[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/
const SAFE_IMAGE_MEDIA_TYPES: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
}

function roomAttachmentSegment(roomId: string): string {
    return createHash('sha256').update(roomId).digest('hex')
}

export function getGroupChatAttachmentDir(roomId: string): string {
    return resolve(config.appHome, 'group-chat', 'attachments', roomAttachmentSegment(roomId))
}

export function getGroupChatAttachmentPath(roomId: string, storedName: string): string | null {
    const normalizedName = basename(storedName)
    if (!normalizedName || normalizedName !== storedName) return null
    const roomDir = getGroupChatAttachmentDir(roomId)
    const filePath = resolve(roomDir, normalizedName)
    return isPathWithin(filePath, roomDir) ? filePath : null
}

export async function getGroupChatAttachmentBytes(roomId: string): Promise<number> {
    const directory = getGroupChatAttachmentDir(roomId)
    try {
        const entries = await readdir(directory, { withFileTypes: true })
        let total = 0
        for (const entry of entries) {
            if (!entry.isFile()) continue
            total += (await stat(resolve(directory, entry.name))).size
        }
        return total
    } catch (error: any) {
        if (error?.code === 'ENOENT') return 0
        throw error
    }
}

export async function deleteGroupChatAttachments(roomId: string): Promise<void> {
    await rm(getGroupChatAttachmentDir(roomId), { recursive: true, force: true })
}

type GroupChatContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; name: string; path: string; media_type: string }
    | { type: 'file'; name: string; path: string; media_type: string }

export type NormalizedHumanGroupChatContent = {
    storageContent: GroupChatContentBlock[]
    runtimeInput: GroupChatContentBlock[]
}

function safeAttachmentDisplayName(value: unknown, fallback: string): string {
    const normalized = String(value || '').replace(/\\/g, '/')
    return basename(normalized)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255) || fallback
}

function safeAttachmentMediaType(value: unknown): string {
    const mediaType = String(value || '').trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
        ? mediaType
        : 'application/octet-stream'
}

/**
 * Never trust a human Socket.IO client to provide a local attachment path.
 * Rebind every attachment block to an existing regular file in this room's
 * private attachment directory before it can be passed to an Agent runtime.
 */
export function normalizeHumanGroupChatContent(
    roomId: string,
    content: Array<Record<string, unknown>>,
): NormalizedHumanGroupChatContent {
    if (content.length > MAX_GROUP_CHAT_CONTENT_BLOCKS) {
        throw new Error('Too many group chat content blocks')
    }

    const storageContent: GroupChatContentBlock[] = []
    const runtimeInput: GroupChatContentBlock[] = []
    for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
            throw new Error('Invalid group chat content block')
        }
        if (rawBlock.type === 'text') {
            if (typeof rawBlock.text !== 'string') throw new Error('Invalid group chat text block')
            const block: GroupChatContentBlock = { type: 'text', text: rawBlock.text }
            storageContent.push(block)
            runtimeInput.push(block)
            continue
        }
        if (rawBlock.type !== 'image' && rawBlock.type !== 'file') {
            throw new Error('Unsupported group chat content block')
        }

        const untrustedPath = typeof rawBlock.path === 'string' ? rawBlock.path.replace(/\\/g, '/') : ''
        const storedName = basename(untrustedPath)
        if (!STORED_ATTACHMENT_NAME_PATTERN.test(storedName)) {
            throw new Error('Invalid group chat attachment')
        }
        const filePath = getGroupChatAttachmentPath(roomId, storedName)
        if (!filePath) throw new Error('Invalid group chat attachment')
        let info
        try {
            info = lstatSync(filePath)
        } catch {
            throw new Error('Group chat attachment was not uploaded to this room')
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GROUP_CHAT_ATTACHMENT_SIZE) {
            throw new Error('Invalid group chat attachment')
        }

        const extension = extname(storedName).toLowerCase()
        const type = rawBlock.type
        if (type === 'image' && !SAFE_IMAGE_MEDIA_TYPES[extension]) {
            throw new Error('Invalid group chat image attachment')
        }
        const name = safeAttachmentDisplayName(rawBlock.name, storedName)
        const mediaType = type === 'image'
            ? SAFE_IMAGE_MEDIA_TYPES[extension]
            : safeAttachmentMediaType(rawBlock.media_type)
        storageContent.push({ type, name, path: storedName, media_type: mediaType })
        runtimeInput.push({ type, name, path: filePath, media_type: mediaType })
    }
    return { storageContent, runtimeInput }
}

type PublishedAttachmentMessage = {
    senderId?: string
    senderName?: string
    role?: string
    content?: unknown
}

type PublishedAttachmentAgent = {
    agentId?: string
}

const SAFE_PUBLISHED_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const LEGACY_UPLOAD_NAME_PATTERN = /^[a-f0-9]{16}(?:\.[a-z0-9]{1,12})?$/

function contentBlocks(content: unknown): any[] {
    if (Array.isArray(content)) return content
    if (typeof content !== 'string') return []
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
    try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

export function findPublishedGroupChatAttachmentPath(
    storedName: string,
    messages: PublishedAttachmentMessage[],
    agents: PublishedAttachmentAgent[],
): string | null {
    if (!storedName || basename(storedName) !== storedName) return null
    const agentIds = new Set(agents.map(agent => String(agent.agentId || '')).filter(Boolean))

    for (const message of messages) {
        const isAgentMessage = (
            message.role === 'assistant' || message.role === 'tool' || message.role === 'agent_run'
        ) && agentIds.has(String(message.senderId || ''))
        for (const block of contentBlocks(message.content)) {
            if (block?.type !== 'image' || typeof block.path !== 'string') continue
            const publishedPath = resolve(block.path)
            if (basename(publishedPath) !== storedName) continue
            const isLegacyUpload = LEGACY_UPLOAD_NAME_PATTERN.test(storedName) &&
                isPathWithin(publishedPath, config.uploadDir)
            const isSafeAgentImage = isAgentMessage &&
                SAFE_PUBLISHED_IMAGE_EXTENSIONS.has(extname(publishedPath).toLowerCase())
            if (isLegacyUpload || isSafeAgentImage) return publishedPath
        }
    }
    return null
}
