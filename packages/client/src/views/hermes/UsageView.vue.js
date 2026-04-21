/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { NButton } from 'naive-ui';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUsageStore } from '@/stores/hermes/usage';
import StatCards from '@/components/hermes/usage/StatCards.vue';
import ModelBreakdown from '@/components/hermes/usage/ModelBreakdown.vue';
import DailyTrend from '@/components/hermes/usage/DailyTrend.vue';
const { t } = useI18n();
const usageStore = useUsageStore();
onMounted(() => {
    usageStore.loadSessions();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "usage-view" },
});
/** @type {__VLS_StyleScopedClasses['usage-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('usage.title'));
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    size: "small",
    quaternary: true,
    loading: (__VLS_ctx.usageStore.isLoading),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    size: "small",
    quaternary: true,
    loading: (__VLS_ctx.usageStore.isLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.usageStore.loadSessions();
            // @ts-ignore
            [t, usageStore, usageStore,];
        } });
const { default: __VLS_7 } = __VLS_3.slots;
(__VLS_ctx.t('usage.refresh'));
// @ts-ignore
[t,];
var __VLS_3;
var __VLS_4;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "usage-content" },
});
/** @type {__VLS_StyleScopedClasses['usage-content']} */ ;
if (__VLS_ctx.usageStore.isLoading && __VLS_ctx.usageStore.sessions.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "usage-loading" },
    });
    /** @type {__VLS_StyleScopedClasses['usage-loading']} */ ;
    (__VLS_ctx.t('common.loading'));
}
else if (__VLS_ctx.usageStore.sessions.length > 0) {
    const __VLS_8 = StatCards;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent1(__VLS_8, new __VLS_8({}));
    const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
    const __VLS_13 = ModelBreakdown;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({}));
    const __VLS_15 = __VLS_14({}, ...__VLS_functionalComponentArgsRest(__VLS_14));
    const __VLS_18 = DailyTrend;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({}));
    const __VLS_20 = __VLS_19({}, ...__VLS_functionalComponentArgsRest(__VLS_19));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "usage-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['usage-empty']} */ ;
    (__VLS_ctx.t('usage.noData'));
}
// @ts-ignore
[t, t, usageStore, usageStore, usageStore,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
