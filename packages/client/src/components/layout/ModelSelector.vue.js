/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed } from 'vue';
import { NModal, NInput } from 'naive-ui';
import { useAppStore } from '@/stores/hermes/app';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const appStore = useAppStore();
const showModal = ref(false);
const searchQuery = ref('');
const collapsedGroups = ref({});
const filteredGroups = computed(() => {
    const q = searchQuery.value.toLowerCase().trim();
    if (!q)
        return appStore.modelGroups;
    return appStore.modelGroups
        .map(g => ({
        ...g,
        models: g.models.filter(m => m.toLowerCase().includes(q)),
    }))
        .filter(g => g.models.length > 0 || g.label.toLowerCase().includes(q));
});
function toggleGroup(provider) {
    collapsedGroups.value[provider] = !collapsedGroups.value[provider];
}
function isGroupCollapsed(provider) {
    return !!collapsedGroups.value[provider];
}
function handleSelect(model, provider) {
    appStore.switchModel(model, provider);
    showModal.value = false;
    searchQuery.value = '';
}
function openModal() {
    collapsedGroups.value = {};
    searchQuery.value = '';
    showModal.value = true;
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "model-selector" },
});
/** @type {__VLS_StyleScopedClasses['model-selector']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "model-label" },
});
/** @type {__VLS_StyleScopedClasses['model-label']} */ ;
(__VLS_ctx.t('models.title'));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.openModal) },
    ...{ class: "model-trigger" },
});
/** @type {__VLS_StyleScopedClasses['model-trigger']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "model-name" },
    title: (__VLS_ctx.appStore.selectedModel),
});
/** @type {__VLS_StyleScopedClasses['model-name']} */ ;
(__VLS_ctx.appStore.selectedModel || '—');
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    ...{ class: "model-arrow" },
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
});
/** @type {__VLS_StyleScopedClasses['model-arrow']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NModal | typeof __VLS_components.NModal} */
NModal;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('models.title')),
    ...{ style: ({ width: 'min(480px, calc(100vw - 32px))' }) },
    maskClosable: (true),
}));
const __VLS_2 = __VLS_1({
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('models.title')),
    ...{ style: ({ width: 'min(480px, calc(100vw - 32px))' }) },
    maskClosable: (true),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    value: (__VLS_ctx.searchQuery),
    placeholder: (__VLS_ctx.t('models.searchPlaceholder')),
    clearable: true,
    size: "small",
    ...{ class: "model-search" },
}));
const __VLS_8 = __VLS_7({
    value: (__VLS_ctx.searchQuery),
    placeholder: (__VLS_ctx.t('models.searchPlaceholder')),
    clearable: true,
    size: "small",
    ...{ class: "model-search" },
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
/** @type {__VLS_StyleScopedClasses['model-search']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "model-list" },
});
/** @type {__VLS_StyleScopedClasses['model-list']} */ ;
for (const [group] of __VLS_vFor((__VLS_ctx.filteredGroups))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (group.provider),
        ...{ class: "model-group" },
    });
    /** @type {__VLS_StyleScopedClasses['model-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.toggleGroup(group.provider);
                // @ts-ignore
                [t, t, t, openModal, appStore, appStore, showModal, searchQuery, filteredGroups, toggleGroup,];
            } },
        ...{ class: "model-group-header" },
    });
    /** @type {__VLS_StyleScopedClasses['model-group-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        ...{ class: "model-group-arrow" },
        ...{ class: ({ collapsed: __VLS_ctx.isGroupCollapsed(group.provider) }) },
        width: "12",
        height: "12",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    /** @type {__VLS_StyleScopedClasses['model-group-arrow']} */ ;
    /** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "6 9 12 15 18 9",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "model-group-label" },
    });
    /** @type {__VLS_StyleScopedClasses['model-group-label']} */ ;
    (group.label);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "model-group-count" },
    });
    /** @type {__VLS_StyleScopedClasses['model-group-count']} */ ;
    (group.models.length);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "model-group-items" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.isGroupCollapsed(group.provider)) }, null, null);
    /** @type {__VLS_StyleScopedClasses['model-group-items']} */ ;
    for (const [model] of __VLS_vFor((group.models))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    __VLS_ctx.handleSelect(model, group.provider);
                    // @ts-ignore
                    [isGroupCollapsed, isGroupCollapsed, handleSelect,];
                } },
            key: (model),
            ...{ class: "model-item" },
            ...{ class: ({ active: model === __VLS_ctx.appStore.selectedModel && group.provider === __VLS_ctx.appStore.selectedProvider }) },
        });
        /** @type {__VLS_StyleScopedClasses['model-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "model-item-name" },
        });
        /** @type {__VLS_StyleScopedClasses['model-item-name']} */ ;
        (model);
        if (model === __VLS_ctx.appStore.selectedModel && group.provider === __VLS_ctx.appStore.selectedProvider) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                ...{ class: "model-check" },
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "2.5",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
            /** @type {__VLS_StyleScopedClasses['model-check']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
                points: "20 6 9 17 4 12",
            });
        }
        // @ts-ignore
        [appStore, appStore, appStore, appStore,];
    }
    // @ts-ignore
    [];
}
if (__VLS_ctx.filteredGroups.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "model-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['model-empty']} */ ;
    (__VLS_ctx.searchQuery ? 'No results' : 'No models');
}
// @ts-ignore
[searchQuery, filteredGroups,];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
