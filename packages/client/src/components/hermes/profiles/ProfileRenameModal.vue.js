/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref } from 'vue';
import { NModal, NForm, NFormItem, NInput, NButton, useMessage } from 'naive-ui';
import { useProfilesStore } from '@/stores/hermes/profiles';
import { useI18n } from 'vue-i18n';
const props = defineProps();
const emit = defineEmits();
const { t } = useI18n();
const profilesStore = useProfilesStore();
const message = useMessage();
const showModal = ref(true);
const loading = ref(false);
const newName = ref('');
async function handleSave() {
    if (!newName.value.trim()) {
        message.warning(t('profiles.newNamePlaceholder'));
        return;
    }
    loading.value = true;
    try {
        const ok = await profilesStore.renameProfile(props.profileName, newName.value.trim());
        if (ok) {
            message.success(t('profiles.renameSuccess'));
            emit('saved');
        }
        else {
            message.error(t('profiles.renameFailed'));
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
    title: (__VLS_ctx.t('profiles.rename')),
    ...{ style: ({ width: 'min(420px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('profiles.rename')),
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
/** @ts-ignore @type {typeof __VLS_components.NForm | typeof __VLS_components.NForm} */
NForm;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    labelPlacement: "top",
}));
const __VLS_11 = __VLS_10({
    labelPlacement: "top",
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
const { default: __VLS_14 } = __VLS_12.slots;
let __VLS_15;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({
    label: (__VLS_ctx.t('profiles.newName')),
    required: true,
}));
const __VLS_17 = __VLS_16({
    label: (__VLS_ctx.t('profiles.newName')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
const { default: __VLS_20 } = __VLS_18.slots;
let __VLS_21;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_22 = __VLS_asFunctionalComponent1(__VLS_21, new __VLS_21({
    ...{ 'onKeyup': {} },
    value: (__VLS_ctx.newName),
    placeholder: (__VLS_ctx.t('profiles.newNamePlaceholder')),
}));
const __VLS_23 = __VLS_22({
    ...{ 'onKeyup': {} },
    value: (__VLS_ctx.newName),
    placeholder: (__VLS_ctx.t('profiles.newNamePlaceholder')),
}, ...__VLS_functionalComponentArgsRest(__VLS_22));
let __VLS_26;
const __VLS_27 = ({ keyup: {} },
    { onKeyup: (__VLS_ctx.handleSave) });
var __VLS_24;
var __VLS_25;
// @ts-ignore
[t, t, newName, handleSave,];
var __VLS_18;
// @ts-ignore
[];
var __VLS_12;
{
    const { footer: __VLS_28 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_29;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_30 = __VLS_asFunctionalComponent1(__VLS_29, new __VLS_29({
        ...{ 'onClick': {} },
    }));
    const __VLS_31 = __VLS_30({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_30));
    let __VLS_34;
    const __VLS_35 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_36 } = __VLS_32.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, handleClose,];
    var __VLS_32;
    var __VLS_33;
    let __VLS_37;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_38 = __VLS_asFunctionalComponent1(__VLS_37, new __VLS_37({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }));
    const __VLS_39 = __VLS_38({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_38));
    let __VLS_42;
    const __VLS_43 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSave) });
    const { default: __VLS_44 } = __VLS_40.slots;
    (__VLS_ctx.t('common.confirm'));
    // @ts-ignore
    [t, loading, handleSave,];
    var __VLS_40;
    var __VLS_41;
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
    __typeProps: {},
});
export default {};
