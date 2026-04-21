/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref } from 'vue';
import { NModal, NUpload, NButton, useMessage } from 'naive-ui';
import { useProfilesStore } from '@/stores/hermes/profiles';
import { useI18n } from 'vue-i18n';
const emit = defineEmits();
const { t } = useI18n();
const profilesStore = useProfilesStore();
const message = useMessage();
const showModal = ref(true);
const loading = ref(false);
const fileList = ref([]);
const ACCEPT_TYPES = [
    '.tar.gz',
    '.tgz',
    '.gz',
    '.zip',
];
function beforeUpload({ file }) {
    const name = file.name?.toLowerCase() || '';
    const valid = ACCEPT_TYPES.some(ext => name.endsWith(ext));
    if (!valid) {
        message.warning(t('profiles.importInvalidFile'));
        return false;
    }
    return true;
}
async function handleSave() {
    if (!fileList.value.length) {
        message.warning(t('profiles.importSelectFile'));
        return;
    }
    loading.value = true;
    try {
        const file = fileList.value[0].file;
        if (!file) {
            message.error(t('profiles.importFailed'));
            return;
        }
        const ok = await profilesStore.importProfile(file);
        if (ok) {
            message.success(t('profiles.importSuccess'));
            emit('saved');
        }
        else {
            message.error(t('profiles.importFailed'));
        }
    }
    finally {
        loading.value = false;
    }
}
function handleClose() {
    showModal.value = false;
    setTimeout(() => emit('close'), 200);
}
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NModal | typeof __VLS_components.NModal} */
NModal;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('profiles.import')),
    ...{ style: ({ width: 'min(420px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('profiles.import')),
    ...{ style: ({ width: 'min(420px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ afterLeave: {} },
    { onAfterLeave: (...[$event]) => {
            __VLS_ctx.emit('close');
            // @ts-ignore
            [showModal, t, loading, emit,];
        } });
var __VLS_7 = {};
const { default: __VLS_8 } = __VLS_3.slots;
let __VLS_9;
/** @ts-ignore @type {typeof __VLS_components.NUpload | typeof __VLS_components.NUpload} */
NUpload;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    ...{ 'onBeforeUpload': {} },
    fileList: (__VLS_ctx.fileList),
    max: (1),
    accept: (__VLS_ctx.ACCEPT_TYPES.join(',')),
    disabled: (__VLS_ctx.loading),
}));
const __VLS_11 = __VLS_10({
    ...{ 'onBeforeUpload': {} },
    fileList: (__VLS_ctx.fileList),
    max: (1),
    accept: (__VLS_ctx.ACCEPT_TYPES.join(',')),
    disabled: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
let __VLS_14;
const __VLS_15 = ({ beforeUpload: {} },
    { onBeforeUpload: (__VLS_ctx.beforeUpload) });
const { default: __VLS_16 } = __VLS_12.slots;
let __VLS_17;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_18 = __VLS_asFunctionalComponent1(__VLS_17, new __VLS_17({}));
const __VLS_19 = __VLS_18({}, ...__VLS_functionalComponentArgsRest(__VLS_18));
const { default: __VLS_22 } = __VLS_20.slots;
(__VLS_ctx.t('profiles.importSelectFile'));
// @ts-ignore
[t, loading, fileList, ACCEPT_TYPES, beforeUpload,];
var __VLS_20;
// @ts-ignore
[];
var __VLS_12;
var __VLS_13;
{
    const { footer: __VLS_23 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_24;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent1(__VLS_24, new __VLS_24({
        ...{ 'onClick': {} },
    }));
    const __VLS_26 = __VLS_25({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    let __VLS_29;
    const __VLS_30 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_31 } = __VLS_27.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, handleClose,];
    var __VLS_27;
    var __VLS_28;
    let __VLS_32;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
        disabled: (!__VLS_ctx.fileList.length),
    }));
    const __VLS_34 = __VLS_33({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
        disabled: (!__VLS_ctx.fileList.length),
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    let __VLS_37;
    const __VLS_38 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSave) });
    const { default: __VLS_39 } = __VLS_35.slots;
    (__VLS_ctx.t('common.confirm'));
    // @ts-ignore
    [t, loading, fileList, handleSave,];
    var __VLS_35;
    var __VLS_36;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_3;
var __VLS_4;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
