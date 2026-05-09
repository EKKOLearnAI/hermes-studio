// ─── Agent Identity Instructions ────────────────────────────

import type { MemberInfo } from './types'
import { getSystemPrompt } from '../../../lib/llm-prompt'

interface AgentInstructionsParams {
    agentName: string
    roomName: string
    agentDescription: string
    memberNames: string[]
    members: MemberInfo[]
}

export function buildAgentInstructions(params: AgentInstructionsParams): string {
    // Deduplicate members by name (primary key) to avoid duplicate roles
    // If multiple entries have the same name, prefer the one with description
    const uniqueMembersMap = new Map<string, MemberInfo>()

    for (const m of params.members) {
        const existing = uniqueMembersMap.get(m.name)
        // Prefer entries with description
        if (!existing || (m.description && !existing.description)) {
            uniqueMembersMap.set(m.name, m)
        }
    }

    const uniqueMembers = Array.from(uniqueMembersMap.values())

    let memberSection: string
    if (uniqueMembers.length > 0) {
        memberSection = uniqueMembers
            .map(m => m.description ? `- ${m.name}: ${m.description}` : `- ${m.name}`)
            .join('\n')
    } else if (params.memberNames.length > 0) {
        // Deduplicate member names as well
        const uniqueNames = Array.from(new Set(params.memberNames))
        memberSection = uniqueNames.map(n => `- ${n}`).join('\n')
    } else {
        memberSection = '- 未知'
    }

    // Handle empty agent description
    const roleDescription = params.agentDescription?.trim()
        ? params.agentDescription
        : '专业的 AI 助手，随时准备协助解决问题。'

    const basePrompt = `你是"${params.agentName}"，群聊房间"${params.roomName}"中的 AI 助手。

你的角色：${roleDescription}

当前房间成员：
${memberSection}

规则：
- 有人用 @${params.agentName} 提及你时才需要回复，重点回应提及你的人。
- 禁止@自己。
- 回答简洁、对群聊有帮助。
- 不要假装是人类，需要时明确表明自己是 AI。
- 对话历史中包含多个人的消息，每条消息前标有发送者名字。
- 对话开头可能包含之前的对话摘要，用于提供更早的上下文。
- 回复最新一条提及你的消息。
- 如果需要其他 agent 协作或明确回复某个人，使用 @名字 来提及对方。
- 自行判断对话是否已经结束——如果问题已解决、达成共识、或对方只是陈述不需要回复，则不要再 @任何人，直接结束回复，避免产生无意义的循环对话。`

    return getSystemPrompt(basePrompt)
}

// ─── Summarization Prompts ─────────────────────────────────

export function buildSummarizationSystemPrompt(): string {
    return `你是一个群聊对话的摘要助手。请创建一份结构化摘要，帮助 AI 助手快速理解完整的对话上下文并智能回复。

使用以下格式：

当前话题：
- 现在在聊什么，目标是什么

已知结论：
- 已达成哪些共识，哪些问题已经回答过

待回复消息：
- 还剩谁的问题没回，下一步要做什么

关键人物：
- 人名、角色、引用关系

重要上下文：
- 不要丢时间线和立场变化
- 少写废话，多保留"可行动信息"
- 重点保留：谁说了什么、结论是什么、下一步是什么
- 关键的 URL、代码片段、错误信息、约束条件

规则：
- 基于事实，不要编造信息。
- 保持简洁（500 字以内）。
- 聚焦于帮助 AI 回复下一条消息的可行动信息。
- 使用与对话相同的语言。
- 不要回复对话内容，只输出摘要。`
}

export function buildFullSummaryPrompt(): string {
    return '请对上方对话创建一份简洁的摘要。只输出摘要内容。'
}

export function buildIncrementalUpdatePrompt(): string {
    return '对话自上次摘要后有了新的内容。请更新摘要，整合新消息。保持相同格式，更新所有部分。只输出更新后的摘要。'
}
