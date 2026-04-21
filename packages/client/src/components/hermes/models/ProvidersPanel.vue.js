/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import ProviderCard from './ProviderCard.vue';
import { useModelsStore } from '@/stores/hermes/models';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const modelsStore = useModelsStore();
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
if (__VLS_ctx.modelsStore.providers.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-state" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "48",
        height: "48",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1",
        ...{ class: "empty-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M12 2L2 7l10 5 10-5-10-5z",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M2 17l10 5 10-5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M2 12l10 5 10-5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.t('models.noProviders'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "providers-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['providers-grid']} */ ;
    for (const [g] of __VLS_vFor((__VLS_ctx.modelsStore.providers))) {
        const __VLS_0 = ProviderCard;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            key: (g.provider),
            provider: (g),
        }));
        const __VLS_2 = __VLS_1({
            key: (g.provider),
            provider: (g),
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
        // @ts-ignore
        [modelsStore, modelsStore, t,];
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
