/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed } from 'vue';
import { NButton, useMessage, useDialog } from 'naive-ui';
import { useModelsStore } from '@/stores/hermes/models';
import { useI18n } from 'vue-i18n';
const props = defineProps();
const { t } = useI18n();
const modelsStore = useModelsStore();
const message = useMessage();
const dialog = useDialog();
const isCustom = computed(() => props.provider.provider.startsWith('custom:'));
const displayName = computed(() => props.provider.label);
const deleting = ref(false);
async function handleDelete() {
    dialog.warning({
        title: t('models.deleteProvider'),
        content: t('models.deleteConfirm', { name: displayName.value }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
            deleting.value = true;
            try {
                await modelsStore.removeProvider(props.provider.provider);
                message.success(t('models.providerDeleted'));
            }
            catch (e) {
                message.error(e.message);
            }
            finally {
                deleting.value = false;
            }
        },
    });
}
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "provider-card" },
});
/** @type {__VLS_StyleScopedClasses['provider-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-header" },
});
/** @type {__VLS_StyleScopedClasses['card-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "provider-name" },
});
/** @type {__VLS_StyleScopedClasses['provider-name']} */ ;
(__VLS_ctx.displayName);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "type-badge" },
    ...{ class: (__VLS_ctx.isCustom ? 'custom' : 'builtin') },
});
/** @type {__VLS_StyleScopedClasses['type-badge']} */ ;
(__VLS_ctx.isCustom ? __VLS_ctx.t('models.customType') : __VLS_ctx.t('models.builtIn'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-body" },
});
/** @type {__VLS_StyleScopedClasses['card-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('models.provider'));
__VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
    ...{ class: "info-value mono" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.provider.provider);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('models.baseUrl'));
__VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
    ...{ class: "info-value mono" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.provider.base_url);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-actions" },
});
/** @type {__VLS_StyleScopedClasses['card-actions']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
    loading: (__VLS_ctx.deleting),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
    loading: (__VLS_ctx.deleting),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (__VLS_ctx.handleDelete) });
const { default: __VLS_7 } = __VLS_3.slots;
(__VLS_ctx.t('common.delete'));
// @ts-ignore
[displayName, isCustom, isCustom, t, t, t, t, t, provider, provider, deleting, handleDelete,];
var __VLS_3;
var __VLS_4;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeProps: {},
});
export default {};
