/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { useI18n } from 'vue-i18n';
import { useUsageStore } from '@/stores/hermes/usage';
const { t } = useI18n();
const usageStore = useUsageStore();
function formatTokens(n) {
    if (n >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'K';
    return String(n);
}
function formatCost(n) {
    if (n === 0)
        return '$0.00';
    if (n < 0.01)
        return '<$0.01';
    return '$' + n.toFixed(2);
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['stat-cards']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-cards']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-cards" },
});
/** @type {__VLS_StyleScopedClasses['stat-cards']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-card" },
});
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-label" },
});
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
(__VLS_ctx.t('usage.totalTokens'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-value" },
});
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
(__VLS_ctx.formatTokens(__VLS_ctx.usageStore.totalTokens));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-sub" },
});
/** @type {__VLS_StyleScopedClasses['stat-sub']} */ ;
(__VLS_ctx.formatTokens(__VLS_ctx.usageStore.totalInputTokens));
(__VLS_ctx.t('usage.inputTokens'));
(__VLS_ctx.formatTokens(__VLS_ctx.usageStore.totalOutputTokens));
(__VLS_ctx.t('usage.outputTokens'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-card" },
});
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-label" },
});
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
(__VLS_ctx.t('usage.totalSessions'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-value" },
});
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
(__VLS_ctx.usageStore.totalSessions);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-sub" },
});
/** @type {__VLS_StyleScopedClasses['stat-sub']} */ ;
(__VLS_ctx.t('usage.avgPerDay', { n: __VLS_ctx.usageStore.avgSessionsPerDay.toFixed(1) }));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-card" },
});
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-label" },
});
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
(__VLS_ctx.t('usage.estimatedCost'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-value" },
});
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
(__VLS_ctx.formatCost(__VLS_ctx.usageStore.estimatedCost));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-card" },
});
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-label" },
});
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
(__VLS_ctx.t('usage.cacheHitRate'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "stat-value" },
});
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
(__VLS_ctx.usageStore.cacheHitRate !== null ? __VLS_ctx.usageStore.cacheHitRate.toFixed(1) + '%' : '--');
if (__VLS_ctx.usageStore.cacheHitRate !== null) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "stat-sub" },
    });
    /** @type {__VLS_StyleScopedClasses['stat-sub']} */ ;
    (__VLS_ctx.formatTokens(__VLS_ctx.usageStore.totalCacheTokens));
    (__VLS_ctx.t('usage.tokens'));
}
// @ts-ignore
[t, t, t, t, t, t, t, t, formatTokens, formatTokens, formatTokens, formatTokens, usageStore, usageStore, usageStore, usageStore, usageStore, usageStore, usageStore, usageStore, usageStore, usageStore, formatCost,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
