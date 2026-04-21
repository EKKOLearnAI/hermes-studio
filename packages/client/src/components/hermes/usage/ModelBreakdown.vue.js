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
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "model-breakdown" },
});
/** @type {__VLS_StyleScopedClasses['model-breakdown']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "section-title" },
});
/** @type {__VLS_StyleScopedClasses['section-title']} */ ;
(__VLS_ctx.t('usage.modelBreakdown'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "model-list" },
});
/** @type {__VLS_StyleScopedClasses['model-list']} */ ;
for (const [m] of __VLS_vFor((__VLS_ctx.usageStore.modelUsage))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (m.model),
        ...{ class: "model-row" },
    });
    /** @type {__VLS_StyleScopedClasses['model-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "model-name" },
    });
    /** @type {__VLS_StyleScopedClasses['model-name']} */ ;
    (m.model);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "model-bar-wrap" },
    });
    /** @type {__VLS_StyleScopedClasses['model-bar-wrap']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
        ...{ class: "model-bar" },
        ...{ style: ({ width: (m.totalTokens / __VLS_ctx.usageStore.modelUsage[0].totalTokens * 100) + '%' }) },
    });
    /** @type {__VLS_StyleScopedClasses['model-bar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "model-tokens" },
    });
    /** @type {__VLS_StyleScopedClasses['model-tokens']} */ ;
    (__VLS_ctx.formatTokens(m.totalTokens));
    // @ts-ignore
    [t, usageStore, usageStore, formatTokens,];
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
