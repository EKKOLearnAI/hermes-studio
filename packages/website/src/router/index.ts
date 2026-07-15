import { createRouter, createWebHashHistory } from 'vue-router'

const EmptyView = { render: () => null }

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'landing',
      component: () => import('@/views/LandingView.vue'),
    },
    {
      path: '/docs',
      name: 'docs',
      component: () => import('@/views/DocsView.vue'),
      redirect: { name: 'docs.getting-started' },
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
          path: 'esp32',
          name: 'docs.esp32',
          component: EmptyView,
          meta: { page: 'esp32Intro' },
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

export default router
