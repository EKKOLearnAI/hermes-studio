import { ref, computed } from 'vue';

const STORAGE_KEY_DEFAULT_WORKSPACES = 'hermes:default_workspaces';
const STORAGE_KEY_RECENT_WORKSPACES = 'hermes:recent_workspaces';
const MAX_RECENT_WORKSPACES = 10;

interface WorkspaceEntry {
  path: string;
  lastUsed: number;
  useCount: number;
  pinned?: boolean;
}

export function useDefaultWorkspace(_profile: string) {
  const defaultWorkspaces = ref<string[]>([]);
  const recentWorkspaces = ref<WorkspaceEntry[]>([]);

  // 加载默认工作区列表（全局，不分 profile）
  function loadDefaultWorkspaces(): string[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_DEFAULT_WORKSPACES);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('Failed to load default workspaces:', e);
    }
    return [];
  }

  // 保存默认工作区列表
  function saveDefaultWorkspaces(workspaces: string[]): void {
    try {
      localStorage.setItem(STORAGE_KEY_DEFAULT_WORKSPACES, JSON.stringify(workspaces));
      defaultWorkspaces.value = workspaces;
    } catch (e) {
      console.error('Failed to save default workspaces:', e);
    }
  }

  // 添加默认工作区
  function addDefaultWorkspace(path: string): void {
    const current = loadDefaultWorkspaces();
    if (!current.includes(path)) {
      current.push(path);
      saveDefaultWorkspaces(current);
    }
  }

  // 移除默认工作区
  function removeDefaultWorkspace(path: string): void {
    const current = loadDefaultWorkspaces();
    const filtered = current.filter(p => p !== path);
    saveDefaultWorkspaces(filtered);
  }

  // 切换默认工作区状态
  function toggleDefaultWorkspace(path: string): boolean {
    const current = loadDefaultWorkspaces();
    if (current.includes(path)) {
      removeDefaultWorkspace(path);
      return false;
    } else {
      addDefaultWorkspace(path);
      return true;
    }
  }

  // 检查是否为默认工作区
  function isDefaultWorkspace(path: string): boolean {
    return defaultWorkspaces.value.includes(path);
  }

  // 加载最近使用的工作区（全局，不分 profile）
  function loadRecentWorkspaces(): WorkspaceEntry[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_RECENT_WORKSPACES);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('Failed to load recent workspaces:', e);
    }
    return [];
  }

  // 保存最近使用的工作区
  function saveRecentWorkspaces(workspaces: WorkspaceEntry[]): void {
    try {
      localStorage.setItem(STORAGE_KEY_RECENT_WORKSPACES, JSON.stringify(workspaces));
      recentWorkspaces.value = workspaces;
    } catch (e) {
      console.error('Failed to save recent workspaces:', e);
    }
  }

  // 记录工作区使用
  function recordWorkspaceUsage(path: string): void {
    const current = loadRecentWorkspaces();
    const existing = current.find(w => w.path === path);
    
    if (existing) {
      existing.lastUsed = Date.now();
      existing.useCount++;
    } else {
      current.push({
        path,
        lastUsed: Date.now(),
        useCount: 1
      });
    }

    // 按最近使用时间排序，保留最新的 MAX_RECENT_WORKSPACES 个
    current.sort((a, b) => b.lastUsed - a.lastUsed);
    const trimmed = current.slice(0, MAX_RECENT_WORKSPACES);
    
    saveRecentWorkspaces(trimmed);
  }

  // 获取排序后的最近工作区（最近使用的在前）
  function getSortedRecentWorkspaces(): WorkspaceEntry[] {
    return [...recentWorkspaces.value].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  // 获取默认工作区中最近使用的（用于自动选择）
  function getMostRecentDefaultWorkspace(): string | null {
    if (defaultWorkspaces.value.length === 0) {
      return null;
    }

    // 从最近使用记录中找第一个默认工作区
    const recent = getSortedRecentWorkspaces();
    for (const entry of recent) {
      if (defaultWorkspaces.value.includes(entry.path)) {
        return entry.path;
      }
    }

    // 如果没有使用记录，返回第一个默认工作区
    return defaultWorkspaces.value[0];
  }

  // 初始化
  function init(): void {
    defaultWorkspaces.value = loadDefaultWorkspaces();
    recentWorkspaces.value = loadRecentWorkspaces();
  }

  // 计算属性：默认工作区数量
  const defaultWorkspaceCount = computed(() => defaultWorkspaces.value.length);

  // 计算属性：是否有默认工作区
  const hasDefaultWorkspace = computed(() => defaultWorkspaces.value.length > 0);

  // 计算属性：最近使用的默认工作区（自动选择的）
  const autoSelectedWorkspace = computed(() => getMostRecentDefaultWorkspace());

  return {
    defaultWorkspaces,
    recentWorkspaces,
    loadDefaultWorkspaces,
    saveDefaultWorkspaces,
    addDefaultWorkspace,
    removeDefaultWorkspace,
    toggleDefaultWorkspace,
    isDefaultWorkspace,
    loadRecentWorkspaces,
    saveRecentWorkspaces,
    recordWorkspaceUsage,
    getSortedRecentWorkspaces,
    getMostRecentDefaultWorkspace,
    init,
    defaultWorkspaceCount,
    hasDefaultWorkspace,
    autoSelectedWorkspace
  };
}
