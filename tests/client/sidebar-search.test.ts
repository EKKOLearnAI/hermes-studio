// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const openSessionSearchMock = vi.hoisted(() => vi.fn());
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: "test",
  latestVersion: "",
  isDocker: false,
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}));

vi.mock("@/composables/useSessionSearch", () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}));

vi.mock("@/stores/hermes/app", () => ({
  useAppStore: () => mockAppStore,
}));

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useRoute: () => ({ name: "hermes.chat" }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  };
});

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: "en" }, setLocaleMessage: vi.fn() },
  }),
}));

vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock("/logo.png", () => ({
  default: "logo.png",
}));

vi.mock("@/components/layout/ProfileSelector.vue", () => ({
  default: { name: "ProfileSelector", template: "<div />" },
}));

vi.mock("@/components/layout/ModelSelector.vue", () => ({
  default: { name: "ModelSelector", template: "<div />" },
}));

vi.mock("@/components/layout/LanguageSwitch.vue", () => ({
  default: { name: "LanguageSwitch", template: "<div />" },
}));

vi.mock("@/components/layout/ThemeSwitch.vue", () => ({
  default: { name: "ThemeSwitch", template: "<div />" },
}));

vi.mock("@/components/common/RouteLinkItem.vue", () => ({
  default: {
    name: "RouteLinkItem",
    props: ["to", "active"],
    template:
      '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}));

vi.mock("naive-ui", async () => {
  const actual = await vi.importActual<any>("naive-ui");
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NModal: {
      props: ["show"],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NSelect: {
      template: "<div />",
    },
  };
});

import AppSidebar from "@/components/layout/AppSidebar.vue";

function fakeJwt(payload: Record<string, unknown>) {
  return `header.${btoa(JSON.stringify(payload)).replace(/=/g, "")}.signature`;
}

describe("AppSidebar navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as typeof window & { hermesDesktop?: unknown })
      .hermesDesktop;
    openSessionSearchMock.mockClear();
    mockAppStore.serverVersion = "test";
    mockAppStore.latestVersion = "";
    mockAppStore.isDocker = false;
    mockAppStore.updateAvailable = false;
    mockAppStore.clientOutdated = false;
    mockAppStore.updating = false;
    mockAppStore.sidebarCollapsed = false;
    mockAppStore.reloadClient.mockClear();
    mockAppStore.doUpdate.mockReset();
    mockAppStore.doUpdate.mockResolvedValue(false);
  });

  it("keeps page-sidebar-only actions out of the app sidebar", () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    expect(wrapper.text()).not.toContain("sidebar.search");
    expect(wrapper.text()).not.toContain("sidebar.reloadClientVersion");
    expect(wrapper.find(".sidebar-return-tab").exists()).toBe(true);
  });

  it("does not show the legacy version management entry in the desktop shell", () => {
    (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
    };
    const desktopWrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    });

    expect(desktopWrapper.find(".version-management-btn").exists()).toBe(false);
    expect(desktopWrapper.find(".version-management-modal-stub").exists()).toBe(false);
  });

  it("keeps navigation flat when the sidebar is collapsed", () => {
    mockAppStore.sidebarCollapsed = true;
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    expect(wrapper.classes()).toContain("collapsed");
    expect(wrapper.findAll(".nav-group-label")).toHaveLength(0);
    expect(
      wrapper.findAll(".sidebar-nav > .route-link-item").length,
    ).toBeGreaterThan(0);
  });

  it("removes the Hermes entry while hiding Hermes-only tools and device management", () => {
    localStorage.setItem(
      "hermes_api_key",
      fakeJwt({ sub: "2", role: "admin" }),
    );
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    const navigationLabels = wrapper
      .findAllComponents({ name: "RouteLinkItem" })
      .map((item) => item.text().trim());

    expect(navigationLabels).not.toContain("Hermes");
    expect(navigationLabels).not.toContain("sidebar.mcp");
    expect(navigationLabels).not.toContain("sidebar.skills");
    expect(navigationLabels).not.toContain("sidebar.journey");
    expect(wrapper.text()).toContain("sidebar.theme");
    expect(wrapper.text().indexOf("sidebar.petdex")).toBeGreaterThan(
      wrapper.text().indexOf("sidebar.theme"),
    );
    expect(wrapper.text()).not.toContain("sidebar.devices");
  });

  it("uses the regular update button to open Docker upgrade guidance", async () => {
    mockAppStore.isDocker = true;
    mockAppStore.updateAvailable = true;
    mockAppStore.latestVersion = "0.6.29";
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    });

    const button = wrapper.get(".update-btn:not(.version-management-btn)");
    expect(button.classes()).not.toContain("docker-update-btn");
    expect(button.text()).toContain("sidebar.updateVersion");

    await button.trigger("click");

    expect(mockAppStore.doUpdate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("sidebar.dockerUpdateGuide");
  });

  it("keeps the original npm update action outside Docker", async () => {
    mockAppStore.isDocker = false;
    mockAppStore.updateAvailable = true;
    mockAppStore.latestVersion = "0.6.29";
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    });

    await wrapper
      .get(".update-btn:not(.version-management-btn)")
      .trigger("click");

    expect(mockAppStore.doUpdate).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain("sidebar.dockerUpdateGuide");
  });
});
