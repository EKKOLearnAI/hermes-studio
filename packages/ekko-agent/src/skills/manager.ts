import { randomUUID } from 'node:crypto'
import type { AgentSkill } from './types'
import type { EkkoToolManager } from '../tools/manager'
import type { SkillManageInput } from '../tools/skills'
import type { AgentToolContext, AgentToolResult } from '../tools/types'

export interface EkkoSkillOperationOptions {
  profile?: string
  runId?: string
}

export interface EkkoSkillCreateInput extends EkkoSkillOperationOptions {
  name: string
  content: string
  category?: string
}

export interface EkkoSkillEditInput extends EkkoSkillOperationOptions {
  name: string
  content: string
}

export interface EkkoSkillPatchInput extends EkkoSkillOperationOptions {
  name: string
  oldString: string
  newString: string
  filePath?: string
  replaceAll?: boolean
}

export interface EkkoSkillSupportFileInput extends EkkoSkillOperationOptions {
  name: string
  filePath: string
  fileContent?: string
}

/** Public skill module used through `ekko.skill`. */
export class EkkoSkillManager {
  private readonly tools: EkkoToolManager
  private readonly registeredSkills = new Map<string, Map<string, AgentSkill>>()

  constructor(tools: EkkoToolManager) {
    this.tools = tools
  }

  register(skill: AgentSkill, profile = 'default'): void {
    const key = normalizeProfile(profile)
    let skills = this.registeredSkills.get(key)
    if (!skills) {
      skills = new Map()
      this.registeredSkills.set(key, skills)
    }
    skills.set(skill.id, skill)
  }

  registerMany(skills: AgentSkill[], profile = 'default'): void {
    for (const skill of skills) this.register(skill, profile)
  }

  unregister(id: string, profile = 'default'): boolean {
    return this.registeredSkills.get(normalizeProfile(profile))?.delete(id) ?? false
  }

  get(id: string, profile = 'default'): AgentSkill | undefined {
    return this.registeredSkills.get(normalizeProfile(profile))?.get(id)
  }

  registered(profile = 'default'): AgentSkill[] {
    return [...(this.registeredSkills.get(normalizeProfile(profile))?.values() || [])]
  }

  discover(query = '', options: EkkoSkillOperationOptions = {}): Promise<AgentToolResult> {
    return this.execute('skill_list', { query }, options)
  }

  view(
    name: string,
    filePath?: string,
    options: EkkoSkillOperationOptions = {},
  ): Promise<AgentToolResult> {
    return this.execute('skill_view', {
      name,
      ...(filePath ? { filePath } : {}),
    }, options)
  }

  create(input: EkkoSkillCreateInput): Promise<AgentToolResult> {
    return this.manage({
      action: 'create',
      name: input.name,
      content: input.content,
      category: input.category,
    }, input)
  }

  async edit(input: EkkoSkillEditInput): Promise<AgentToolResult> {
    const options = operationOptions(input)
    const viewed = await this.view(input.name, undefined, options)
    if (!viewed.ok) return viewed
    return this.manage({ action: 'edit', name: input.name, content: input.content }, options)
  }

  async patch(input: EkkoSkillPatchInput): Promise<AgentToolResult> {
    const options = operationOptions(input)
    const viewed = await this.view(input.name, input.filePath, options)
    if (!viewed.ok) return viewed
    return this.manage({
      action: 'patch',
      name: input.name,
      oldString: input.oldString,
      newString: input.newString,
      filePath: input.filePath,
      replaceAll: input.replaceAll,
    }, options)
  }

  async delete(
    name: string,
    options: EkkoSkillOperationOptions & { confirmed: boolean },
  ): Promise<AgentToolResult> {
    const operation = operationOptions(options)
    const viewed = await this.view(name, undefined, operation)
    if (!viewed.ok) return viewed
    return this.manage({ action: 'delete', name, confirmed: options.confirmed }, operation)
  }

  async writeFile(input: EkkoSkillSupportFileInput & { fileContent: string }): Promise<AgentToolResult> {
    const options = operationOptions(input)
    // Existing files require a same-run view. A missing file is allowed.
    await this.view(input.name, input.filePath, options)
    return this.manage({
      action: 'write_file',
      name: input.name,
      filePath: input.filePath,
      fileContent: input.fileContent,
    }, options)
  }

  async removeFile(input: EkkoSkillSupportFileInput): Promise<AgentToolResult> {
    const options = operationOptions(input)
    const viewed = await this.view(input.name, input.filePath, options)
    if (!viewed.ok) return viewed
    return this.manage({
      action: 'remove_file',
      name: input.name,
      filePath: input.filePath,
    }, options)
  }

  manage(
    input: SkillManageInput,
    options: EkkoSkillOperationOptions = {},
  ): Promise<AgentToolResult> {
    return this.execute('skill_manage', input, options)
  }

  runtimeSkills(profile = 'default'): AgentSkill[] {
    return this.registered(profile)
  }

  private execute(
    name: string,
    input: Record<string, unknown>,
    options: EkkoSkillOperationOptions,
  ): Promise<AgentToolResult> {
    const profile = normalizeProfile(options.profile)
    const context: AgentToolContext = {
      runId: options.runId || randomUUID(),
      profileId: profile,
      skillMutationSource: 'foreground',
    }
    return this.tools.execute(name, input, context, profile)
  }
}

function operationOptions(options: EkkoSkillOperationOptions): EkkoSkillOperationOptions {
  return {
    profile: normalizeProfile(options.profile),
    runId: options.runId || randomUUID(),
  }
}

function normalizeProfile(profile?: string): string {
  return String(profile || '').trim() || 'default'
}
