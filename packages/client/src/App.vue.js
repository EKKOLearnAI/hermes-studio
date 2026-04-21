/// <reference types="../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { onMounted, onUnmounted, computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { darkTheme, NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui';
import { getThemeOverrides } from '@/styles/theme';
import { useTheme } from '@/composables/useTheme';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { useKeyboard } from '@/composables/useKeyboard';
import { useAppStore } from '@/stores/hermes/app';
const { isDark } = useTheme();
const appStore = useAppStore();
const route = useRoute();
const router = useRouter();
const ready = ref(false);
const themeOverrides = computed(() => getThemeOverrides(isDark.value));
const naiveTheme = computed(() => isDark.value ? darkTheme : null);
const isLoginPage = computed(() => route.name === 'login');
// Close mobile sidebar on route change
watch(() => route.path, () => {
    appStore.closeSidebar();
});
// Wait for router to resolve before rendering layout
router.isReady().then(() => {
    ready.value = true;
});
onMounted(() => {
    if (!isLoginPage.value) {
        appStore.loadModels();
        appStore.startHealthPolling();
    }
});
onUnmounted(() => {
    appStore.stopHealthPolling();
});
useKeyboard();
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['no-sidebar']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NConfigProvider | typeof __VLS_components.NConfigProvider} */
NConfigProvider;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    theme: (__VLS_ctx.naiveTheme),
    themeOverrides: (__VLS_ctx.themeOverrides),
}));
const __VLS_2 = __VLS_1({
    theme: (__VLS_ctx.naiveTheme),
    themeOverrides: (__VLS_ctx.themeOverrides),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_5 = {};
const { default: __VLS_6 } = __VLS_3.slots;
let __VLS_7;
/** @ts-ignore @type {typeof __VLS_components.NMessageProvider | typeof __VLS_components.NMessageProvider} */
NMessageProvider;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({}));
const __VLS_9 = __VLS_8({}, ...__VLS_functionalComponentArgsRest(__VLS_8));
const { default: __VLS_12 } = __VLS_10.slots;
let __VLS_13;
/** @ts-ignore @type {typeof __VLS_components.NDialogProvider | typeof __VLS_components.NDialogProvider} */
NDialogProvider;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({}));
const __VLS_15 = __VLS_14({}, ...__VLS_functionalComponentArgsRest(__VLS_14));
const { default: __VLS_18 } = __VLS_16.slots;
let __VLS_19;
/** @ts-ignore @type {typeof __VLS_components.NNotificationProvider | typeof __VLS_components.NNotificationProvider} */
NNotificationProvider;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent1(__VLS_19, new __VLS_19({}));
const __VLS_21 = __VLS_20({}, ...__VLS_functionalComponentArgsRest(__VLS_20));
const { default: __VLS_24 } = __VLS_22.slots;
if (__VLS_ctx.ready) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "app-layout" },
        ...{ class: ({ 'no-sidebar': __VLS_ctx.isLoginPage }) },
    });
    /** @type {__VLS_StyleScopedClasses['app-layout']} */ ;
    /** @type {__VLS_StyleScopedClasses['no-sidebar']} */ ;
    if (!__VLS_ctx.isLoginPage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.appStore.toggleSidebar) },
            ...{ class: "hamburger-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['hamburger-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
            src: "/logo.png",
            alt: "Menu",
            ...{ style: {} },
        });
    }
    if (!__VLS_ctx.isLoginPage && __VLS_ctx.appStore.sidebarOpen) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
            ...{ onClick: (__VLS_ctx.appStore.closeSidebar) },
            ...{ class: "mobile-backdrop" },
        });
        /** @type {__VLS_StyleScopedClasses['mobile-backdrop']} */ ;
    }
    if (!__VLS_ctx.isLoginPage) {
        const __VLS_25 = AppSidebar;
        // @ts-ignore
        const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({}));
        const __VLS_27 = __VLS_26({}, ...__VLS_functionalComponentArgsRest(__VLS_26));
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
        ...{ class: "app-main" },
    });
    /** @type {__VLS_StyleScopedClasses['app-main']} */ ;
    let __VLS_30;
    /** @ts-ignore @type {typeof __VLS_components.routerView | typeof __VLS_components.RouterView} */
    routerView;
    // @ts-ignore
    const __VLS_31 = __VLS_asFunctionalComponent1(__VLS_30, new __VLS_30({}));
    const __VLS_32 = __VLS_31({}, ...__VLS_functionalComponentArgsRest(__VLS_31));
}
// @ts-ignore
[naiveTheme, themeOverrides, ready, isLoginPage, isLoginPage, isLoginPage, isLoginPage, appStore, appStore, appStore,];
var __VLS_22;
// @ts-ignore
[];
var __VLS_16;
// @ts-ignore
[];
var __VLS_10;
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
