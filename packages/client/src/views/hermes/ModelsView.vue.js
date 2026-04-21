/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted } from 'vue';
import { NButton, NSpin } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue';
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue';
import { useModelsStore } from '@/stores/hermes/models';
import { useAppStore } from '@/stores/hermes/app';
const { t } = useI18n();
const modelsStore = useModelsStore();
const appStore = useAppStore();
const showModal = ref(false);
onMounted(() => {
    modelsStore.fetchProviders();
});
function openCreateModal() {
    showModal.value = true;
}
function handleModalClose() {
    showModal.value = false;
}
async function handleSaved() {
    await modelsStore.fetchProviders();
    appStore.loadModels();
    handleModalClose();
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "models-view" },
});
/** @type {__VLS_StyleScopedClasses['models-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('models.title'));
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    type: "primary",
    size: "small",
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    type: "primary",
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (__VLS_ctx.openCreateModal) });
const { default: __VLS_7 } = __VLS_3.slots;
{
    const { icon: __VLS_8 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "5",
        x2: "12",
        y2: "19",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "5",
        y1: "12",
        x2: "19",
        y2: "12",
    });
    // @ts-ignore
    [t, openCreateModal,];
}
(__VLS_ctx.t('models.addProvider'));
// @ts-ignore
[t,];
var __VLS_3;
var __VLS_4;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "models-content" },
});
/** @type {__VLS_StyleScopedClasses['models-content']} */ ;
let __VLS_9;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    show: (__VLS_ctx.modelsStore.loading && __VLS_ctx.modelsStore.providers.length === 0),
}));
const __VLS_11 = __VLS_10({
    show: (__VLS_ctx.modelsStore.loading && __VLS_ctx.modelsStore.providers.length === 0),
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
const { default: __VLS_14 } = __VLS_12.slots;
const __VLS_15 = ProvidersPanel;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({}));
const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
// @ts-ignore
[modelsStore, modelsStore,];
var __VLS_12;
if (__VLS_ctx.showModal) {
    const __VLS_20 = ProviderFormModal;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent1(__VLS_20, new __VLS_20({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }));
    const __VLS_22 = __VLS_21({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    let __VLS_25;
    const __VLS_26 = ({ close: {} },
        { onClose: (__VLS_ctx.handleModalClose) });
    const __VLS_27 = ({ saved: {} },
        { onSaved: (__VLS_ctx.handleSaved) });
    var __VLS_23;
    var __VLS_24;
}
// @ts-ignore
[showModal, handleModalClose, handleSaved,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
