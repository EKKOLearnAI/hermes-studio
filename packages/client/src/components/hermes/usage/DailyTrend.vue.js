/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { useI18n } from 'vue-i18n';
import { useUsageStore } from '@/stores/hermes/usage';
import { computed } from 'vue';
export default {};
const __VLS_export = await (async () => {
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
    const maxTokens = computed(() => Math.max(...usageStore.dailyUsage.map(d => d.tokens), 1));
    const __VLS_ctx = {
        ...{},
        ...{},
    };
    let __VLS_components;
    let __VLS_intrinsics;
    let __VLS_directives;
    /** @type {__VLS_StyleScopedClasses['bar-col']} */ ;
    /** @type {__VLS_StyleScopedClasses['bar-col']} */ ;
    /** @type {__VLS_StyleScopedClasses['bar-tooltip']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "daily-trend" },
    });
    /** @type {__VLS_StyleScopedClasses['daily-trend']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "section-title" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
    (__VLS_ctx.t('usage.dailyTrend'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "bar-chart" },
    });
    /** @type {__VLS_StyleScopedClasses['bar-chart']} */ ;
    for (const [d] of __VLS_vFor((__VLS_ctx.usageStore.dailyUsage))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (d.date),
            ...{ class: "bar-col" },
        });
        /** @type {__VLS_StyleScopedClasses['bar-col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "bar-track" },
        });
        /** @type {__VLS_StyleScopedClasses['bar-track']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
            ...{ class: "bar-fill" },
            ...{ style: ({ height: (d.tokens / __VLS_ctx.maxTokens * 100) + '%' }) },
        });
        /** @type {__VLS_StyleScopedClasses['bar-fill']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "bar-tooltip" },
        });
        /** @type {__VLS_StyleScopedClasses['bar-tooltip']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tooltip-date" },
        });
        /** @type {__VLS_StyleScopedClasses['tooltip-date']} */ ;
        (d.date);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tooltip-row" },
        });
        /** @type {__VLS_StyleScopedClasses['tooltip-row']} */ ;
        (__VLS_ctx.t('usage.tokens'));
        (__VLS_ctx.formatTokens(d.tokens));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tooltip-row" },
        });
        /** @type {__VLS_StyleScopedClasses['tooltip-row']} */ ;
        (__VLS_ctx.t('usage.cache'));
        (__VLS_ctx.formatTokens(d.cache));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tooltip-row" },
        });
        /** @type {__VLS_StyleScopedClasses['tooltip-row']} */ ;
        (__VLS_ctx.t('usage.sessions'));
        (d.sessions);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tooltip-row" },
        });
        /** @type {__VLS_StyleScopedClasses['tooltip-row']} */ ;
        (__VLS_ctx.t('usage.cost'));
        (__VLS_ctx.formatCost(d.cost));
        // @ts-ignore
        [t, t, t, t, t, usageStore, maxTokens, formatTokens, formatTokens, formatCost,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "bar-dates" },
    });
    /** @type {__VLS_StyleScopedClasses['bar-dates']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.usageStore.dailyUsage[0]?.date.slice(5));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.usageStore.dailyUsage[__VLS_ctx.usageStore.dailyUsage.length - 1]?.date.slice(5));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "trend-table" },
    });
    /** @type {__VLS_StyleScopedClasses['trend-table']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.table, __VLS_intrinsics.table)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.thead, __VLS_intrinsics.thead)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.th, __VLS_intrinsics.th)({});
    (__VLS_ctx.t('usage.date'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.th, __VLS_intrinsics.th)({});
    (__VLS_ctx.t('usage.tokens'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.th, __VLS_intrinsics.th)({});
    (__VLS_ctx.t('usage.cache'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.th, __VLS_intrinsics.th)({});
    (__VLS_ctx.t('usage.sessions'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.th, __VLS_intrinsics.th)({});
    (__VLS_ctx.t('usage.cost'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.tbody, __VLS_intrinsics.tbody)({});
    for (const [d] of __VLS_vFor(([...__VLS_ctx.usageStore.dailyUsage].reverse().slice(0, 30)))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({
            key: (d.date),
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (d.date);
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.formatTokens(d.tokens));
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.formatTokens(d.cache));
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (d.sessions);
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.formatCost(d.cost));
        // @ts-ignore
        [t, t, t, t, t, usageStore, usageStore, usageStore, usageStore, formatTokens, formatTokens, formatCost,];
    }
    // @ts-ignore
    [];
    return (await import('vue')).defineComponent({});
})();
