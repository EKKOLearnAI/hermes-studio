/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { computed, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NButton, useMessage } from "naive-ui";
import { useAppStore } from "@/stores/hermes/app";
import ModelSelector from "./ModelSelector.vue";
import ProfileSelector from "./ProfileSelector.vue";
import LanguageSwitch from "./LanguageSwitch.vue";
import ThemeSwitch from "./ThemeSwitch.vue";
import danceVideoLight from "@/assets/dance-light.mp4";
import danceVideoDark from "@/assets/dance-dark.mp4";
import { useTheme } from "@/composables/useTheme";
const { t } = useI18n();
const { isDark } = useTheme();
const message = useMessage();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const selectedKey = computed(() => route.name);
const collapsedGroups = reactive({});
function toggleGroup(key) {
    collapsedGroups[key] = !collapsedGroups[key];
}
function isGroupCollapsed(key) {
    return !!collapsedGroups[key];
}
function handleNav(key) {
    router.push({ name: key });
}
async function handleUpdate() {
    const ok = await appStore.doUpdate();
    if (ok) {
        message.success(t('sidebar.updateSuccess'), { duration: 5000 });
    }
    else {
        message.error(t('sidebar.updateFailed'));
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['nav-group']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['logo-dance']} */ ;
/** @type {__VLS_StyleScopedClasses['status-row']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "sidebar" },
    ...{ class: ({ open: __VLS_ctx.appStore.sidebarOpen }) },
});
/** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['open']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.router.push('/hermes/chat');
            // @ts-ignore
            [appStore, router,];
        } },
    ...{ class: "sidebar-logo" },
});
/** @type {__VLS_StyleScopedClasses['sidebar-logo']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    src: "/logo.png",
    alt: "Hermes",
    ...{ class: "logo-img" },
});
/** @type {__VLS_StyleScopedClasses['logo-img']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "logo-text" },
});
/** @type {__VLS_StyleScopedClasses['logo-text']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.video)({
    ...{ class: "logo-dance" },
    src: (__VLS_ctx.isDark ? __VLS_ctx.danceVideoDark : __VLS_ctx.danceVideoLight),
    autoplay: true,
    loop: true,
    muted: true,
    playsinline: true,
});
/** @type {__VLS_StyleScopedClasses['logo-dance']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
    ...{ class: "sidebar-nav" },
});
/** @type {__VLS_StyleScopedClasses['sidebar-nav']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.chat');
            // @ts-ignore
            [isDark, danceVideoDark, danceVideoLight, handleNav,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.chat' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.chat"));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "nav-group" },
});
/** @type {__VLS_StyleScopedClasses['nav-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.toggleGroup('agent');
            // @ts-ignore
            [selectedKey, t, toggleGroup,];
        } },
    ...{ class: "nav-group-label" },
});
/** @type {__VLS_StyleScopedClasses['nav-group-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.groupAgent"));
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    ...{ class: "nav-group-arrow" },
    ...{ class: ({ collapsed: __VLS_ctx.isGroupCollapsed('agent') }) },
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
/** @type {__VLS_StyleScopedClasses['nav-group-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
__VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.isGroupCollapsed('agent')) }, null, null);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.jobs');
            // @ts-ignore
            [handleNav, t, isGroupCollapsed, isGroupCollapsed,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.jobs' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "3",
    y: "4",
    width: "18",
    height: "18",
    rx: "2",
    ry: "2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "16",
    y1: "2",
    x2: "16",
    y2: "6",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "8",
    y1: "2",
    x2: "8",
    y2: "6",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "3",
    y1: "10",
    x2: "21",
    y2: "10",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.jobs"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.channels');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.channels' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.channels"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.skills');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.skills' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polygon)({
    points: "12 2 2 7 12 12 22 7 12 2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "2 17 12 22 22 17",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "2 12 12 17 22 12",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.skills"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.memory');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.memory' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M9 18h6",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M10 22h4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.memory"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.models');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.models' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
    cx: "12",
    cy: "12",
    r: "3",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M12 1v4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M12 19v4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M1 12h4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M19 12h4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M4.22 4.22l2.83 2.83",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M16.95 16.95l2.83 2.83",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M4.22 19.78l2.83-2.83",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M16.95 7.05l2.83-2.83",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.models"));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "nav-group" },
});
/** @type {__VLS_StyleScopedClasses['nav-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.toggleGroup('monitoring');
            // @ts-ignore
            [selectedKey, t, toggleGroup,];
        } },
    ...{ class: "nav-group-label" },
});
/** @type {__VLS_StyleScopedClasses['nav-group-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.groupMonitoring"));
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    ...{ class: "nav-group-arrow" },
    ...{ class: ({ collapsed: __VLS_ctx.isGroupCollapsed('monitoring') }) },
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
/** @type {__VLS_StyleScopedClasses['nav-group-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
__VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.isGroupCollapsed('monitoring')) }, null, null);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.logs');
            // @ts-ignore
            [handleNav, t, isGroupCollapsed, isGroupCollapsed,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.logs' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "14 2 14 8 20 8",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "16",
    y1: "13",
    x2: "8",
    y2: "13",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "16",
    y1: "17",
    x2: "8",
    y2: "17",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "10 9 9 9 8 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.logs"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.usage');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.usage' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "3",
    y: "12",
    width: "4",
    height: "9",
    rx: "1",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "10",
    y: "7",
    width: "4",
    height: "14",
    rx: "1",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "17",
    y: "3",
    width: "4",
    height: "18",
    rx: "1",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.usage"));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "nav-group" },
});
/** @type {__VLS_StyleScopedClasses['nav-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.toggleGroup('tools');
            // @ts-ignore
            [selectedKey, t, toggleGroup,];
        } },
    ...{ class: "nav-group-label" },
});
/** @type {__VLS_StyleScopedClasses['nav-group-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.groupTools"));
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    ...{ class: "nav-group-arrow" },
    ...{ class: ({ collapsed: __VLS_ctx.isGroupCollapsed('tools') }) },
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
/** @type {__VLS_StyleScopedClasses['nav-group-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
__VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.isGroupCollapsed('tools')) }, null, null);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.terminal');
            // @ts-ignore
            [handleNav, t, isGroupCollapsed, isGroupCollapsed,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.terminal' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "4 17 10 11 4 5",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "12",
    y1: "19",
    x2: "20",
    y2: "19",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.terminal"));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "nav-group" },
});
/** @type {__VLS_StyleScopedClasses['nav-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.toggleGroup('system');
            // @ts-ignore
            [selectedKey, t, toggleGroup,];
        } },
    ...{ class: "nav-group-label" },
});
/** @type {__VLS_StyleScopedClasses['nav-group-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.groupSystem"));
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    ...{ class: "nav-group-arrow" },
    ...{ class: ({ collapsed: __VLS_ctx.isGroupCollapsed('system') }) },
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
/** @type {__VLS_StyleScopedClasses['nav-group-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
__VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.isGroupCollapsed('system')) }, null, null);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.gateways');
            // @ts-ignore
            [handleNav, t, isGroupCollapsed, isGroupCollapsed,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.gateways' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "2",
    y: "2",
    width: "20",
    height: "8",
    rx: "2",
    ry: "2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
    x: "2",
    y: "14",
    width: "20",
    height: "8",
    rx: "2",
    ry: "2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "6",
    y1: "6",
    x2: "6.01",
    y2: "6",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "6",
    y1: "18",
    x2: "6.01",
    y2: "18",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.gateways"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.profiles');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.profiles' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
    cx: "12",
    cy: "7",
    r: "4",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.profiles"));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.handleNav('hermes.settings');
            // @ts-ignore
            [handleNav, selectedKey, t,];
        } },
    ...{ class: "nav-item" },
    ...{ class: ({ active: __VLS_ctx.selectedKey === 'hermes.settings' }) },
});
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "1.5",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
    cx: "12",
    cy: "12",
    r: "3",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.t("sidebar.settings"));
const __VLS_0 = ProfileSelector;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const __VLS_5 = ModelSelector;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({}));
const __VLS_7 = __VLS_6({}, ...__VLS_functionalComponentArgsRest(__VLS_6));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "sidebar-footer" },
});
/** @type {__VLS_StyleScopedClasses['sidebar-footer']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "status-row" },
});
/** @type {__VLS_StyleScopedClasses['status-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "status-indicator" },
    ...{ class: ({
            connected: __VLS_ctx.appStore.connected,
            disconnected: !__VLS_ctx.appStore.connected,
        }) },
});
/** @type {__VLS_StyleScopedClasses['status-indicator']} */ ;
/** @type {__VLS_StyleScopedClasses['connected']} */ ;
/** @type {__VLS_StyleScopedClasses['disconnected']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-dot" },
});
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-text" },
});
/** @type {__VLS_StyleScopedClasses['status-text']} */ ;
(__VLS_ctx.appStore.connected
    ? __VLS_ctx.t("sidebar.connected")
    : __VLS_ctx.t("sidebar.disconnected"));
const __VLS_10 = LanguageSwitch;
// @ts-ignore
const __VLS_11 = __VLS_asFunctionalComponent1(__VLS_10, new __VLS_10({}));
const __VLS_12 = __VLS_11({}, ...__VLS_functionalComponentArgsRest(__VLS_11));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "version-info" },
});
/** @type {__VLS_StyleScopedClasses['version-info']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.a, __VLS_intrinsics.a)({
    ...{ class: "github-link" },
    href: "https://github.com/EKKOLearnAI/hermes-web-ui",
    target: "_blank",
    rel: "noopener noreferrer",
    title: "GitHub",
});
/** @type {__VLS_StyleScopedClasses['github-link']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "currentColor",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.path)({
    d: "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
(__VLS_ctx.appStore.serverVersion || "0.1.0");
const __VLS_15 = ThemeSwitch;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({}));
const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
if (__VLS_ctx.appStore.updateAvailable) {
    let __VLS_20;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent1(__VLS_20, new __VLS_20({
        ...{ 'onClick': {} },
        type: "primary",
        size: "tiny",
        block: true,
        ...{ class: "update-btn" },
        loading: (__VLS_ctx.appStore.updating),
    }));
    const __VLS_22 = __VLS_21({
        ...{ 'onClick': {} },
        type: "primary",
        size: "tiny",
        block: true,
        ...{ class: "update-btn" },
        loading: (__VLS_ctx.appStore.updating),
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    let __VLS_25;
    const __VLS_26 = ({ click: {} },
        { onClick: (__VLS_ctx.handleUpdate) });
    /** @type {__VLS_StyleScopedClasses['update-btn']} */ ;
    const { default: __VLS_27 } = __VLS_23.slots;
    (__VLS_ctx.appStore.updating ? __VLS_ctx.t('sidebar.updating') : __VLS_ctx.t('sidebar.updateVersion', { version: __VLS_ctx.appStore.latestVersion }));
    // @ts-ignore
    [appStore, appStore, appStore, appStore, appStore, appStore, appStore, appStore, selectedKey, t, t, t, t, t, handleUpdate,];
    var __VLS_23;
    var __VLS_24;
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
