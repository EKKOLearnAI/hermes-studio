<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import RouteLinkItem from "@/components/common/RouteLinkItem.vue";
import { useAppStore } from "@/stores/hermes/app";

const { t } = useI18n();
const route = useRoute();
const appStore = useAppStore();
const isMobile = ref(
  typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px)").matches,
);
const expanded = ref(!isMobile.value);
let mobileQuery: MediaQueryList | null = null;

const activeRoute = computed(() => route.name as string);

function setExpanded(value: boolean) {
  expanded.value = value;
  appStore.setPageSidebarExpanded(value);
}

function handleMobileChange(event: MediaQueryList | MediaQueryListEvent) {
  isMobile.value = event.matches;
  setExpanded(!event.matches);
}

function openSidebar() {
  setExpanded(true);
}

function handleNavClick(event: MouseEvent) {
  if (!isMobile.value) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".route-link-item")) setExpanded(false);
}

onMounted(() => {
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  window.addEventListener("hermes:open-page-sidebar", openSidebar);
});

onUnmounted(() => {
  mobileQuery?.removeEventListener("change", handleMobileChange);
  window.removeEventListener("hermes:open-page-sidebar", openSidebar);
});
</script>

<template>
  <div
    class="hermes-config-backdrop"
    :class="{ active: isMobile && expanded }"
    @click="setExpanded(false)"
  />
  <aside
    class="hermes-config-sidebar"
    :class="{ open: expanded, collapsed: appStore.sidebarCollapsed }"
  >
    <nav class="hermes-config-nav" @click="handleNavClick">
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.jobs' }"
        :active="activeRoute === 'hermes.jobs'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span>{{ t("sidebar.jobs") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.kanban' }"
        :active="activeRoute === 'hermes.kanban'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="5" height="18" rx="1" />
          <rect x="10" y="3" width="5" height="12" rx="1" />
          <rect x="17" y="3" width="4" height="16" rx="1" />
        </svg>
        <span>{{ t("sidebar.kanban") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.channels' }"
        :active="activeRoute === 'hermes.channels'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 4h16v12H7l-3 3V4Z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
        <span>{{ t("sidebar.channels") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.skills' }"
        :active="activeRoute === 'hermes.skills'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </svg>
        <span>{{ t("sidebar.skills") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.plugins' }"
        :active="activeRoute === 'hermes.plugins'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M8.5 3H5a2 2 0 0 0-2 2v3.5a2.5 2.5 0 1 1 0 5V19a2 2 0 0 0 2 2h5.5a2.5 2.5 0 1 1 5 0H19a2 2 0 0 0 2-2v-5.5a2.5 2.5 0 1 1 0-5V5a2 2 0 0 0-2-2h-5.5a2.5 2.5 0 1 1-5 0Z"
          />
        </svg>
        <span>{{ t("sidebar.plugins") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.mcp' }"
        :active="activeRoute === 'hermes.mcp'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="5" width="18" height="10" rx="2" />
          <path d="M8 19h8M12 15v4M8 10h.01M12 10h4" />
        </svg>
        <span>{{ t("sidebar.mcp") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.memory' }"
        :active="activeRoute === 'hermes.memory'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"
          />
        </svg>
        <span>{{ t("sidebar.memory") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.journey' }"
        :active="activeRoute === 'hermes.journey'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
          <path d="M4.4 15.4c3.2 1.1 7.4.4 10.8-2.1 3.1-2.3 4.9-5.5 4.5-8.1" />
          <circle
            cx="19.5"
            cy="4.5"
            r="1.2"
            fill="currentColor"
            stroke="none"
          />
        </svg>
        <span>{{ t("sidebar.journey") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.configSettings' }"
        :active="activeRoute === 'hermes.configSettings'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.9 2.9-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.1h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.9-2.9.1-.1a1.7 1.7 0 0 0 .3-1.8A1.7 1.7 0 0 0 3.1 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.9-2.9.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.9 2.9-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"
          />
        </svg>
        <span>{{ t("sidebar.settings") }}</span>
      </RouteLinkItem>
    </nav>

    <footer class="hermes-config-footer">
      <RouteLinkItem
        class="hermes-config-nav-item hermes-config-return"
        :to="{ name: 'hermes.agentManager' }"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
          <path d="M9 12h11" />
        </svg>
        <span>{{ t("sidebar.backToChat") }}</span>
      </RouteLinkItem>
      <button
        class="hermes-config-collapse"
        type="button"
        :title="
          appStore.sidebarCollapsed
            ? t('sidebar.expand')
            : t('sidebar.collapse')
        "
        @click="appStore.toggleSidebarCollapsed()"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </footer>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.hermes-config-sidebar {
  position: relative;
  width: $sidebar-width;
  min-width: $sidebar-width;
  height: auto;
  min-height: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  margin: 10px;
  padding: 8px 12px 20px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid $border-color;
  border-radius: 14px;
  background-color: $bg-sidebar-surface;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  transition:
    width $transition-normal,
    min-width $transition-normal,
    padding $transition-normal;
}

.hermes-config-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.hermes-config-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-secondary;
  font-size: 14px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;
  width: 100%;
  text-align: start;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    background-color: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  svg {
    flex: 0 0 auto;
  }
}

.hermes-config-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid $border-color;
}

.hermes-config-return {
  flex: 1 1 auto;
  min-width: 0;
  padding: 8px 10px;
  color: $text-muted;
  font-size: 13px;
}

.hermes-config-collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-muted;
  border-radius: $radius-sm;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.hermes-config-sidebar.collapsed {
  width: $sidebar-collapsed-width;
  min-width: $sidebar-collapsed-width;
  padding: 8px 8px 12px;
  overflow: hidden;

  .hermes-config-nav-item {
    justify-content: center;
    gap: 0;
    padding: 10px 4px;

    span {
      display: none;
    }

    svg {
      flex-shrink: 0;
    }
  }

  .hermes-config-footer {
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
  }

  .hermes-config-return {
    width: 100%;
    flex: 0 0 auto;
  }
}

.hermes-config-backdrop {
  display: none;
}

@media (max-width: $breakpoint-mobile) {
  .hermes-config-backdrop {
    position: fixed;
    z-index: 1090;
    inset: 0;
    display: block;
    background: rgba(0, 0, 0, 0.42);
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-normal;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .hermes-config-sidebar {
    position: fixed;
    z-index: 1100;
    inset: 0 auto 0 0;
    height: 100%;
    margin: 0;
    border-width: 0 1px 0 0;
    border-radius: 0;
    transform: translateX(-102%);
    transition: transform $transition-normal;

    &.open {
      transform: translateX(0);
    }
  }
}
</style>
