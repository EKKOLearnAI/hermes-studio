import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import YAML, { type DumpOptions } from 'js-yaml'

type TextUpdater<T = void> = (current: string) => string | { content: string; result: T } | Promise<string | { content: string; result: T }>
type YamlUpdateResult<T> = { data: Record<string, any>; result: T; write?: boolean }
type YamlUpdater<T = void> = (current: Record<string, any>) => Record<string, any> | YamlUpdateResult<T> | Promise<Record<string, any> | YamlUpdateResult<T>>

export interface SafeWriteOptions {
  backup?: boolean
  backupPath?: string
}

export interface SafeYamlOptions extends SafeWriteOptions {
  dumpOptions?: DumpOptions
}

function isTextUpdateResult<T>(value: unknown): value is { content: string; result: T } {
  return !!value && typeof value === 'object' && Object.hasOwn(value as Record<string, unknown>, 'content')
}

function isYamlUpdateResult<T>(value: unknown): value is YamlUpdateResult<T> {
  return !!value && typeof value === 'object' && Object.hasOwn(value as Record<string, unknown>, 'data')
}

export class SafeFileStore {
  private queues = new Map<string, Promise<unknown>>()

  private normalizePath(filePath: string): string {
    return resolve(filePath)
  }

  private async withLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const key = this.normalizePath(filePath)
    const previous = this.queues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const next = previous.then(() => current, () => current)
    this.queues.set(key, next)

    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }

  async readText(filePath: string): Promise<string> {
    return readFile(this.normalizePath(filePath), 'utf-8')
  }

  async writeText(filePath: string, content: string, options: SafeWriteOptions = {}): Promise<void> {
    await this.withLock(filePath, () => this.writeTextUnlocked(filePath, content, options))
  }

  async updateText<T = void>(filePath: string, updater: TextUpdater<T>, options: SafeWriteOptions = {}): Promise<T | undefined> {
    return this.withLock(filePath, async () => {
      let current = ''
      try {
        current = await this.readText(filePath)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }

      const updated = await updater(current)
      const content = isTextUpdateResult<T>(updated) ? updated.content : updated
      await this.writeTextUnlocked(filePath, content, options)
      return isTextUpdateResult<T>(updated) ? updated.result : undefined
    })
  }

  async readYaml(filePath: string): Promise<Record<string, any>> {
    try {
      const raw = await this.readText(filePath)
      return (YAML.load(raw, { json: true }) as Record<string, any>) || {}
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      throw err
    }
  }

  async writeYaml(filePath: string, data: Record<string, any>, options: SafeYamlOptions = {}): Promise<void> {
    const yamlStr = YAML.dump(data, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      ...(options.dumpOptions || {}),
    })
    await this.writeText(filePath, yamlStr, options)
  }

  async updateYaml<T = void>(filePath: string, updater: YamlUpdater<T>, options: SafeYamlOptions = {}): Promise<T | undefined> {
    return this.withLock(filePath, async () => {
      let raw = ''
      try {
        raw = await this.readText(filePath)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
      const current = raw ? ((YAML.load(raw, { json: true }) as Record<string, any>) || {}) : {}
      const updated = await updater(current)
      const data = isYamlUpdateResult<T>(updated) ? updated.data : updated
      if (isYamlUpdateResult<T>(updated) && updated.write === false) {
        return updated.result
      }
      const yamlStr = YAML.dump(data, {
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        ...(options.dumpOptions || {}),
      })
      await this.writeTextUnlocked(filePath, yamlStr, options)
      return isYamlUpdateResult<T>(updated) ? updated.result : undefined
    })
  }

  private async writeTextUnlocked(filePath: string, content: string, options: SafeWriteOptions): Promise<void> {
    const target = this.normalizePath(filePath)
    const dir = dirname(target)
    const temp = `${target}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`

    await mkdir(dir, { recursive: true })
    if (options.backup) {
      try {
        await copyFile(target, options.backupPath || `${target}.bak`)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
    }

    try {
      await writeFile(temp, content, 'utf-8')
      await rename(temp, target)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw err
    }
  }
}

export const safeFileStore = new SafeFileStore()
