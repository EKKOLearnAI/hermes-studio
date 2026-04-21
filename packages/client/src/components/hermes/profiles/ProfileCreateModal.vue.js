/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref } from 'vue';
import { NModal, NForm, NFormItem, NInput, NButton, NSwitch, useMessage } from 'naive-ui';
import { useProfilesStore } from '@/stores/hermes/profiles';
import { useI18n } from 'vue-i18n';
const emit = defineEmits();
const { t } = useI18n();
const profilesStore = useProfilesStore();
const message = useMessage();
const showModal = ref(true);
const loading = ref(false);
const name = ref('');
const clone = ref(false);
async function handleSave() {
    if (!name.value.trim()) {
        message.warning(t('profiles.namePlaceholder'));
        return;
    }
    loading.value = true;
    try {
        const ok = await profilesStore.createProfile(name.value.trim(), clone.value);
        if (ok) {
            message.success(t('profiles.createSuccess', { name: name.value.trim() }));
            emit('saved');
        }
        else {
            message.error(t('profiles.createFailed'));
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
    title: (__VLS_ctx.t('profiles.create')),
    ...{ style: ({ width: 'min(420px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('profiles.create')),
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
    label: (__VLS_ctx.t('profiles.name')),
    required: true,
}));
const __VLS_17 = __VLS_16({
    label: (__VLS_ctx.t('profiles.name')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
const { default: __VLS_20 } = __VLS_18.slots;
let __VLS_21;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_22 = __VLS_asFunctionalComponent1(__VLS_21, new __VLS_21({
    ...{ 'onInput': {} },
    ...{ 'onKeyup': {} },
    value: (__VLS_ctx.name),
    placeholder: (__VLS_ctx.t('profiles.namePlaceholder')),
}));
const __VLS_23 = __VLS_22({
    ...{ 'onInput': {} },
    ...{ 'onKeyup': {} },
    value: (__VLS_ctx.name),
    placeholder: (__VLS_ctx.t('profiles.namePlaceholder')),
}, ...__VLS_functionalComponentArgsRest(__VLS_22));
let __VLS_26;
const __VLS_27 = ({ input: {} },
    { onInput: (...[$event]) => {
            __VLS_ctx.name = $event.replace(/[^a-zA-Z0-9_-]/g, '');
            // @ts-ignore
            [t, t, name, name,];
        } });
const __VLS_28 = ({ keyup: {} },
    { onKeyup: (__VLS_ctx.handleSave) });
var __VLS_24;
var __VLS_25;
// @ts-ignore
[handleSave,];
var __VLS_18;
let __VLS_29;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_30 = __VLS_asFunctionalComponent1(__VLS_29, new __VLS_29({
    label: (__VLS_ctx.t('profiles.cloneFromCurrent')),
}));
const __VLS_31 = __VLS_30({
    label: (__VLS_ctx.t('profiles.cloneFromCurrent')),
}, ...__VLS_functionalComponentArgsRest(__VLS_30));
const { default: __VLS_34 } = __VLS_32.slots;
let __VLS_35;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_36 = __VLS_asFunctionalComponent1(__VLS_35, new __VLS_35({
    value: (__VLS_ctx.clone),
}));
const __VLS_37 = __VLS_36({
    value: (__VLS_ctx.clone),
}, ...__VLS_functionalComponentArgsRest(__VLS_36));
// @ts-ignore
[t, clone,];
var __VLS_32;
// @ts-ignore
[];
var __VLS_12;
{
    const { footer: __VLS_40 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_41;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_42 = __VLS_asFunctionalComponent1(__VLS_41, new __VLS_41({
        ...{ 'onClick': {} },
    }));
    const __VLS_43 = __VLS_42({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_42));
    let __VLS_46;
    const __VLS_47 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_48 } = __VLS_44.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, handleClose,];
    var __VLS_44;
    var __VLS_45;
    let __VLS_49;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_50 = __VLS_asFunctionalComponent1(__VLS_49, new __VLS_49({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }));
    const __VLS_51 = __VLS_50({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_50));
    let __VLS_54;
    const __VLS_55 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSave) });
    const { default: __VLS_56 } = __VLS_52.slots;
    (__VLS_ctx.t('common.create'));
    // @ts-ignore
    [t, loading, handleSave,];
    var __VLS_52;
    var __VLS_53;
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
