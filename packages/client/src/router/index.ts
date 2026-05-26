import { createRouter, createWebHistory, type NavigationGuardNext, type RouteLocationGeneric, type RouteLocationNormalized } from 'vue-router'
import { hasApiKey, isStoredSuperAdmin } from '@/api/client'
import { normalizeLegacyRoutePath } from './legacy-routing'
import { resolveRouterBase } from './runtime-base'

const routerBase = resolveRouterBase()

const router = createRouter({
  history: createWebHistory(routerBase),
  routes: [
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/session/new',
      name: 'hermes.chat',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/session/:sessionId',
      name: 'hermes.session',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/history',
      name: 'hermes.history',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/history/session/:sessionId',
      name: 'hermes.historySession',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/jobs',
      name: 'hermes.jobs',
      component: () => import('@/views/hermes/JobsView.vue'),
    },
    {
      path: '/kanban',
      name: 'hermes.kanban',
      component: () => import('@/views/hermes/KanbanView.vue'),
    },
    {
      path: '/models',
      name: 'hermes.models',
      component: () => import('@/views/hermes/ModelsView.vue'),
    },
    {
      path: '/profiles',
      name: 'hermes.profiles',
      component: () => import('@/views/hermes/ProfilesView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/logs',
      name: 'hermes.logs',
      component: () => import('@/views/hermes/LogsView.vue'),
    },
    {
      path: '/usage',
      name: 'hermes.usage',
      component: () => import('@/views/hermes/UsageView.vue'),
    },
    {
      path: '/performance',
      name: 'hermes.performance',
      component: () => import('@/views/hermes/PerformanceView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/skills-usage',
      name: 'hermes.skillsUsage',
      component: () => import('@/views/hermes/SkillsUsageView.vue'),
    },
    {
      path: '/skills',
      name: 'hermes.skills',
      component: () => import('@/views/hermes/SkillsView.vue'),
    },
    {
      path: '/plugins',
      name: 'hermes.plugins',
      component: () => import('@/views/hermes/PluginsView.vue'),
    },
    {
      path: '/memory',
      name: 'hermes.memory',
      component: () => import('@/views/hermes/MemoryView.vue'),
    },
    {
      path: '/settings',
      name: 'hermes.settings',
      component: () => import('@/views/hermes/SettingsView.vue'),
    },
    {
      path: '/updates',
      name: 'hermes.updates',
      component: () => import('@/views/hermes/UpdatesView.vue'),
    },
    {
      path: '/channels',
      name: 'hermes.channels',
      component: () => import('@/views/hermes/ChannelsView.vue'),
    },
    {
      path: '/terminal',
      name: 'hermes.terminal',
      component: () => import('@/views/hermes/TerminalView.vue'),
    },
    {
      path: '/group-chat',
      name: 'hermes.groupChat',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/group-chat/room/:roomId',
      name: 'hermes.groupChatRoom',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/files',
      name: 'hermes.files',
      component: () => import('@/views/hermes/FilesView.vue'),
    },
    {
      path: '/hermes/chat',
      redirect: { name: 'hermes.chat' },
    },
    {
      path: '/hermes/:pathMatch(.*)*',
      redirect: (to: RouteLocationGeneric) => {
        const target = normalizeLegacyRoutePath(to.fullPath) || '/'
        const [path, queryString = ''] = target.split('?')
        return {
          path,
          query: queryString ? Object.fromEntries(new URLSearchParams(queryString)) : to.query,
        }
      },
    },
  ],
})

router.beforeEach((to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
  // Public pages don't need auth
  if (to.meta.public) {
    // Already has key, skip login
    if (to.name === 'login' && hasApiKey()) {
      next({ path: '/session/new' })
      return
    }
    next()
    return
  }

  // All other pages require token
  if (!hasApiKey()) {
    next({ name: 'login' })
    return
  }

  if (to.meta.requiresSuperAdmin && !isStoredSuperAdmin()) {
    next({ name: 'hermes.chat' })
    return
  }

  next()
})

export default router
