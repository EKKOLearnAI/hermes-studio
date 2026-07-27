import { basename, resolve as pathResolve } from 'path'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import {
    loadActiveAuthenticatedUser,
    type AuthenticatedUser,
} from '../../middleware/user-auth'
import { canManageGroupChatRoom, canReadGroupChatRoom } from '../../services/hermes/group-chat/access'
import { getGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'
import {
    groupWorkspaceRelativePath,
    resolveGroupWorkspacePath,
} from '../../services/hermes/group-chat/workspace-files'
import { isSensitivePath, MAX_DOWNLOAD_SIZE, MAX_EDIT_SIZE } from '../../services/hermes/file-provider'
import { buildFileContentHeaders, getFilePreviewDescriptor } from '../../services/hermes/file-preview'
import { defaultHermesWorkspace } from '../../services/hermes/run-chat/workspace'

type GroupChatWorkspaceStorage = ReturnType<NonNullable<ReturnType<typeof getGroupChatRuntimeServer>>['getStorage']>

type ManagedRoom = {
    room: NonNullable<ReturnType<GroupChatWorkspaceStorage['getRoom']>>
    storage: GroupChatWorkspaceStorage
}

type ManagedRoomContext = {
    params: { roomId: string }
    state?: {
        user?: AuthenticatedUser
        groupChatLocalSubjectId?: string
    }
}

function authorizedWorkspaceRoots({ room, storage }: ManagedRoom): string[] {
    return [
        String(room.workspace || '').trim(),
        ...storage.getRoomAgents(room.id).map(agent => defaultHermesWorkspace(String(agent.profile || 'default'))),
    ].filter((root, index, all) => root && all.indexOf(root) === index)
}

function managedRoom(ctx: ManagedRoomContext, expectedWorkspaceRoot?: string): ManagedRoom {
    const server = getGroupChatRuntimeServer()
    if (!server) throw Object.assign(new Error('Group chat not initialized'), { status: 503, code: 'group_chat_unavailable' })
    const storage = server.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
    const state = ctx.state || {}
    if (state.user) {
        const userId = Number(state.user.id)
        const currentUser = Number.isInteger(userId) && userId > 0
            ? loadActiveAuthenticatedUser(userId)
            : null
        if (currentUser) state.user = currentUser
        else {
            delete state.user
            delete state.groupChatLocalSubjectId
        }
    }
    const localSubjectId = typeof state.groupChatLocalSubjectId === 'string'
        ? state.groupChatLocalSubjectId
        : null
    if (!canManageGroupChatRoom(storage, room.id, state.user, localSubjectId)) {
        if (!canReadGroupChatRoom(storage, room.id, state.user, localSubjectId)) {
            throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
        }
        throw Object.assign(new Error('Access denied'), { status: 403, code: 'permission_denied' })
    }
    if (expectedWorkspaceRoot && !authorizedWorkspaceRoots({ room, storage }).includes(expectedWorkspaceRoot)) {
        throw Object.assign(new Error('Workspace authorization changed'), { status: 403, code: 'permission_denied' })
    }
    return { room, storage }
}

function roomWorkspace(ctx: any): string {
    return String(managedRoom(ctx).room.workspace || '').trim()
}

function handleWorkspaceError(ctx: any, error: any): void {
    ctx.status = Number(error?.status || (error?.code === 'ENOENT' ? 404 : 500))
    ctx.body = {
        error: error?.message || 'Failed to access group chat workspace',
        code: error?.code || 'workspace_file_error',
    }
}

async function resolveRoomPath(ctx: any, path: unknown, options: { allowEmpty?: boolean; allowAbsolute?: boolean } = {}) {
    return resolveGroupWorkspacePath(roomWorkspace(ctx), path, options)
}

async function resolveRoomPreviewPath(ctx: any, path: unknown) {
    const rawPath = typeof path === 'string' ? path.trim() : ''
    const isAbsolute = rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)
    if (!isAbsolute) return resolveRoomPath(ctx, path)

    const managed = managedRoom(ctx)
    const roots = authorizedWorkspaceRoots(managed)
    for (const root of roots) {
        try {
            return await resolveGroupWorkspacePath(root, rawPath, { allowAbsolute: true })
        } catch (error: any) {
            if (error?.code !== 'invalid_path') throw error
        }
    }
    throw Object.assign(new Error('File is outside the room and Agent workspaces'), { status: 400, code: 'invalid_path' })
}

export async function listWorkspaceFiles(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, ctx.query.path, { allowEmpty: true })
        managedRoom(ctx, workspace)
        const info = await stat(fullPath)
        managedRoom(ctx, workspace)
        if (!info.isDirectory()) throw Object.assign(new Error('Not a directory'), { status: 400, code: 'not_a_directory' })
        const dirEntries = await readdir(fullPath, { withFileTypes: true })
        managedRoom(ctx, workspace)
        const entries = await Promise.all(dirEntries.map(async entry => {
            const entryFullPath = pathResolve(fullPath, entry.name)
            const entryStat = await stat(entryFullPath)
            return {
                name: entry.name,
                path: groupWorkspaceRelativePath(workspace, entryFullPath),
                absolutePath: entryFullPath,
                isDir: entryStat.isDirectory(),
                size: entryStat.size,
                modTime: entryStat.mtime.toISOString(),
            }
        }))
        managedRoom(ctx, workspace)
        entries.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
        ctx.body = { entries, path: relativePath, absolutePath: fullPath }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function readWorkspaceFile(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, ctx.query.path)
        managedRoom(ctx, workspace)
        const info = await stat(fullPath)
        managedRoom(ctx, workspace)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })
        if (info.size > MAX_EDIT_SIZE) throw Object.assign(new Error('File too large to edit'), { status: 413, code: 'file_too_large' })
        const data = await readFile(fullPath)
        managedRoom(ctx, workspace)
        ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function readWorkspaceFileContent(ctx: any): Promise<void> {
    try {
        const { relativePath, fullPath, workspace } = await resolveRoomPreviewPath(ctx, ctx.query.path)
        managedRoom(ctx, workspace)
        const info = await stat(fullPath)
        managedRoom(ctx, workspace)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })

        const download = String(ctx.query?.download || '') === '1'
        const textPreview = String(ctx.query?.text || '') === '1'
        const descriptor = getFilePreviewDescriptor(relativePath)
        if (!download && !textPreview && !descriptor) {
            throw Object.assign(new Error('File type is not supported for preview'), { status: 415, code: 'unsupported_preview' })
        }
        const maxBytes = download ? MAX_DOWNLOAD_SIZE : textPreview ? MAX_EDIT_SIZE : descriptor!.maxBytes
        if (info.size > maxBytes) {
            throw Object.assign(new Error(download ? 'File too large to download' : 'File too large to preview'), { status: 413, code: 'file_too_large' })
        }
        const data = await readFile(fullPath)
        managedRoom(ctx, workspace)
        if (data.length > maxBytes) {
            throw Object.assign(new Error(download ? 'File too large to download' : 'File too large to preview'), { status: 413, code: 'file_too_large' })
        }
        const headers = buildFileContentHeaders({
            fileName: basename(relativePath),
            mime: textPreview ? 'text/plain; charset=utf-8' : descriptor?.mime || 'application/octet-stream',
            size: data.length,
            download,
        })
        for (const [name, value] of Object.entries(headers)) ctx.set(name, value)
        ctx.body = data
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function writeWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { path?: unknown; content?: unknown }
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, body?.path)
        managedRoom(ctx, workspace)
        if (isSensitivePath(relativePath)) throw Object.assign(new Error('Cannot modify sensitive file'), { status: 403, code: 'permission_denied' })
        const data = Buffer.from(typeof body?.content === 'string' ? body.content : '', 'utf-8')
        if (data.length > MAX_EDIT_SIZE) throw Object.assign(new Error('Content too large'), { status: 413, code: 'file_too_large' })
        await writeFile(fullPath, data)
        managedRoom(ctx, workspace)
        ctx.body = { ok: true, path: relativePath }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function mkdirWorkspaceFile(ctx: any): Promise<void> {
    try {
        const { fullPath, workspace } = await resolveRoomPath(ctx, (ctx.request.body as { path?: unknown })?.path)
        managedRoom(ctx, workspace)
        await mkdir(fullPath, { recursive: true })
        managedRoom(ctx, workspace)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function deleteWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { path?: unknown; recursive?: unknown }
        const { relativePath, fullPath, workspace } = await resolveRoomPath(ctx, body?.path)
        managedRoom(ctx, workspace)
        if (isSensitivePath(relativePath)) throw Object.assign(new Error('Cannot delete sensitive file'), { status: 403, code: 'permission_denied' })
        const info = await stat(fullPath)
        managedRoom(ctx, workspace)
        await rm(fullPath, info.isDirectory() ? { recursive: Boolean(body?.recursive), force: false } : undefined)
        managedRoom(ctx, workspace)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function renameWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { oldPath?: unknown; newPath?: unknown }
        const oldTarget = await resolveRoomPath(ctx, body?.oldPath)
        managedRoom(ctx, oldTarget.workspace)
        const newTarget = await resolveRoomPath(ctx, body?.newPath)
        managedRoom(ctx, newTarget.workspace)
        if (isSensitivePath(oldTarget.relativePath) || isSensitivePath(newTarget.relativePath)) {
            throw Object.assign(new Error('Cannot rename sensitive file'), { status: 403, code: 'permission_denied' })
        }
        managedRoom(ctx, oldTarget.workspace)
        managedRoom(ctx, newTarget.workspace)
        await rename(oldTarget.fullPath, newTarget.fullPath)
        managedRoom(ctx, oldTarget.workspace)
        managedRoom(ctx, newTarget.workspace)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}

export async function copyWorkspaceFile(ctx: any): Promise<void> {
    try {
        const body = ctx.request.body as { srcPath?: unknown; destPath?: unknown }
        const source = await resolveRoomPath(ctx, body?.srcPath)
        managedRoom(ctx, source.workspace)
        const destination = await resolveRoomPath(ctx, body?.destPath)
        managedRoom(ctx, destination.workspace)
        if (isSensitivePath(destination.relativePath)) throw Object.assign(new Error('Cannot overwrite sensitive file'), { status: 403, code: 'permission_denied' })
        const info = await stat(source.fullPath)
        managedRoom(ctx, source.workspace)
        managedRoom(ctx, destination.workspace)
        if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400, code: 'not_a_file' })
        await copyFile(source.fullPath, destination.fullPath)
        managedRoom(ctx, source.workspace)
        managedRoom(ctx, destination.workspace)
        ctx.body = { ok: true }
    } catch (error) {
        handleWorkspaceError(ctx, error)
    }
}
