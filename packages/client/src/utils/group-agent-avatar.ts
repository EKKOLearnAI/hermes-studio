import type { RoomAgent } from '@/api/hermes/group-chat'
import type { ProfileAvatar } from '@/api/hermes/profiles'

const DEFAULT_AGENT_ICONS: Record<RoomAgent['agent'], string> = {
    hermes: '/coding-agents/hermes.png',
    ekko: '/coding-agents/ekko-agent.png',
    codex: '/coding-agents/codex-openai.png',
    claude: '/coding-agents/claude-code.svg',
}

export function parseStoredAvatar(raw: unknown): ProfileAvatar | null {
    if (!raw) return null
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed) {
            return { type: 'generated', seed: parsed.seed }
        }
        if (parsed?.type === 'image' && typeof parsed.dataUrl === 'string' && parsed.dataUrl) {
            return { type: 'image', dataUrl: parsed.dataUrl }
        }
    } catch {
        // Invalid persisted avatars fall back to the runtime's default icon.
    }
    return null
}

export function defaultGroupAgentAvatar(agent: RoomAgent['agent'] | undefined): ProfileAvatar {
    const runtime = agent && agent in DEFAULT_AGENT_ICONS ? agent : 'hermes'
    return {
        type: 'image',
        dataUrl: DEFAULT_AGENT_ICONS[runtime],
    }
}

export function groupAgentAvatar(agent: Pick<RoomAgent, 'agent' | 'avatar'> | null | undefined): ProfileAvatar {
    return parseStoredAvatar(agent?.avatar) || defaultGroupAgentAvatar(agent?.agent)
}
