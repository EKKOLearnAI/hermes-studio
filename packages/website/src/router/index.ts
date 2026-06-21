import { createRouter, createWebHashHistory } from 'vue-router'
import { hasApiKey, isStoredSuperAdmin } from '@/api/client'

const EmptyView = { render: () => null }

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'landing',
      component: () => import('@/views/LandingView.vue'),
      meta: {
        hideChrome: true,
        title: 'Paulo Cavallari Tech',
      },
    },
    {
      path: '/docs',
      name: 'docs',
      component: () => import('@/views/DocsView.vue'),
      redirect: { name: 'docs.getting-started' },
      meta: {
        title: 'Documentação — Hermes Studio',
      },
      children: [
        {
          path: 'getting-started',
          name: 'docs.getting-started',
          component: EmptyView,
          meta: { page: 'gettingStarted' },
        },
        {
          path: 'configuration',
          name: 'docs.configuration',
          component: EmptyView,
          meta: { page: 'configuration' },
        },
        {
          path: 'features',
          name: 'docs.features',
          component: EmptyView,
          meta: { page: 'features' },
        },
        {
          path: 'hermes-studio-manual',
          name: 'docs.hermes-studio-manual',
          component: EmptyView,
          meta: { page: 'hermesStudioManual' },
        },
        {
          path: 'platforms',
          name: 'docs.platforms',
          component: EmptyView,
          meta: { page: 'platforms' },
        },
        {
          path: 'api',
          name: 'docs.api',
          component: EmptyView,
          meta: { page: 'api' },
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

router.beforeEach((to, _from, next) => {
  // Public pages don't need auth
  if (to.meta.public) {
    // Already has key, skip login
    if (to.name === 'login' && hasApiKey()) {
      next({ path: '/hermes/chat' })
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
