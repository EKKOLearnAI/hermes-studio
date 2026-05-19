/**
 * Hermes 路径检测工具 - 跨平台兼容
 *
 * Hermes 数据目录在不同平台上的位置：
 * - Windows 原生安装: %LOCALAPPDATA%\hermes
 * - Linux/macOS/WSL2: ~/.hermes
 * - 用户自定义: HERMES_HOME 环境变量
 */

import { basename, dirname, resolve, join } from 'path'
import { homedir } from 'os'

/**
 * 智能检测 Hermes 数据目录
 *
 * 检测优先级：
 * 1. HERMES_HOME 环境变量（用户自定义）
 * 2. Windows: %LOCALAPPDATA%\hermes（原生安装）
 * 3. 默认: ~/.hermes（Linux/macOS/WSL2）
 *
 * @returns Hermes 数据目录的绝对路径
 */
export function detectHermesHome(): string {
  // 1. 用户自定义的环境变量（最高优先级）
  if (process.env.HERMES_HOME) {
    return resolve(process.env.HERMES_HOME)
  }

  // 2. Windows：直接使用 %LOCALAPPDATA%\hermes
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
    if (localAppData) {
      return join(localAppData, 'hermes')
    }
  }

  // 3. Linux/macOS：~/.hermes
  return resolve(homedir(), '.hermes')
}

/**
 * Detect the Hermes root data directory.
 *
 * `HERMES_HOME` may intentionally point at a profile directory when launching a
 * specific gateway (`<root>/profiles/<name>`). Web UI profile management needs
 * the root directory so it can read `active_profile` and enumerate profiles.
 */
export function detectHermesRootHome(): string {
  const home = detectHermesHome()
  const parent = dirname(home)
  if (basename(parent) === 'profiles') return dirname(parent)
  return home
}

/**
 * 获取 Hermes CLI 二进制文件路径
 * @param customBin 自定义的 hermes 二进制路径
 * @returns hermes 命令名称或路径
 */
export function getHermesBin(customBin?: string): string {
  if (customBin?.trim()) return customBin.trim()
  if (process.env.HERMES_BIN?.trim()) return process.env.HERMES_BIN.trim()
  return 'hermes'
}
