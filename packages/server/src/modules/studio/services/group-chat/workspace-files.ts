import { join, relative, normalize as pathNormalize, resolve as pathResolve } from 'path'
import { config } from '../../public/config'
import { isNearestExistingRealPathWithin, isPathWithin } from '../files/path'

function safeGroupChatWorkspaceSegment(value: string, fallback: string): string {
    const segment = String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
    return !segment || segment === '.' || segment === '..' ? fallback : segment
}

export function defaultGroupChatWorkspace(profile: string, roomId: string): string {
    return join(
        config.appHome,
        'group-chat',
        safeGroupChatWorkspaceSegment(profile, 'default'),
        safeGroupChatWorkspaceSegment(roomId, 'room'),
    )
}

export function normalizeGroupWorkspaceRelativePath(value: unknown, options: { allowEmpty?: boolean } = {}): string {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw && options.allowEmpty) return ''
    if (!raw) throw Object.assign(new Error('Missing path parameter'), { code: 'missing_path', status: 400 })
    if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
        throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
    const normalized = pathNormalize(raw).replace(/\\/g, '/')
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
    return normalized
}

export function groupWorkspaceRelativePath(workspace: string, fullPath: string): string {
    return relative(workspace, fullPath).replace(/\\/g, '/')
}

export async function resolveGroupWorkspacePath(
    workspaceValue: unknown,
    pathValue: unknown,
    options: { allowEmpty?: boolean; allowAbsolute?: boolean } = {},
): Promise<{ relativePath: string; fullPath: string; workspace: string }> {
    const workspace = typeof workspaceValue === 'string' ? workspaceValue.trim() : ''
    if (!workspace) {
        throw Object.assign(new Error('Room workspace not found'), { code: 'workspace_not_found', status: 404 })
    }

    const rawPath = typeof pathValue === 'string' ? pathValue.trim() : ''
    const isAbsolute = rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)
    const relativePath = isAbsolute && options.allowAbsolute
        ? groupWorkspaceRelativePath(workspace, pathResolve(rawPath))
        : normalizeGroupWorkspaceRelativePath(pathValue, { allowEmpty: options.allowEmpty })
    const fullPath = isAbsolute && options.allowAbsolute ? pathResolve(rawPath) : pathResolve(workspace, relativePath)

    if (!isPathWithin(fullPath, workspace) || !await isNearestExistingRealPathWithin(fullPath, workspace)) {
        throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path', status: 400 })
    }
    return { relativePath, fullPath, workspace }
}
