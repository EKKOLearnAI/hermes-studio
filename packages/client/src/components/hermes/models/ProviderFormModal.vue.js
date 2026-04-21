/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, watch, computed, onMounted } from 'vue';
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, useMessage } from 'naive-ui';
import { useModelsStore } from '@/stores/hermes/models';
import { useI18n } from 'vue-i18n';
import CodexLoginModal from './CodexLoginModal.vue';
const { t } = useI18n();
const emit = defineEmits();
const modelsStore = useModelsStore();
const message = useMessage();
const showModal = ref(true);
const loading = ref(false);
const fetchingModels = ref(false);
const showCodexLogin = ref(false);
const providerType = ref('preset');
const selectedPreset = ref(null);
const formData = ref({
    name: '',
    base_url: '',
    api_key: '',
    model: '',
});
const modelOptions = ref([]);
const CODEX_KEY = 'openai-codex';
const isCodex = computed(() => selectedPreset.value === CODEX_KEY);
const presetOptions = computed(() => modelsStore.allProviders.map(g => ({ label: g.label, value: g.provider })));
function autoGenerateName(url) {
    const clean = url.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '');
    const host = clean.split('/')[0];
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        return t('models.local', { host });
    }
    return host.charAt(0).toUpperCase() + host.slice(1);
}
watch(selectedPreset, (val) => {
    formData.value.model = '';
    if (val) {
        const group = modelsStore.allProviders.find(g => g.provider === val);
        if (group) {
            formData.value.name = group.label;
            formData.value.base_url = group.base_url;
            modelOptions.value = group.models.map((m) => ({ label: m, value: m }));
            if (group.models.length > 0) {
                formData.value.model = group.models[0];
            }
        }
    }
});
watch(() => formData.value.base_url, (url) => {
    if (providerType.value === 'custom' && url.trim() && !formData.value.name) {
        formData.value.name = autoGenerateName(url.trim());
    }
});
watch(providerType, () => {
    modelOptions.value = [];
    formData.value = { name: '', base_url: '', api_key: '', model: '' };
    selectedPreset.value = null;
});
onMounted(() => {
    if (modelsStore.providers.length === 0) {
        modelsStore.fetchProviders();
    }
});
async function fetchModels() {
    const { base_url } = formData.value;
    if (!base_url.trim()) {
        message.warning(t('models.enterBaseUrl'));
        return;
    }
    fetchingModels.value = true;
    try {
        const base = base_url.replace(/\/+$/, '');
        const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
        const headers = {};
        if (formData.value.api_key.trim()) {
            headers['Authorization'] = `Bearer ${formData.value.api_key.trim()}`;
        }
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data.data))
            throw new Error(t('models.unexpectedFormat'));
        modelOptions.value = data.data.map(m => ({ label: m.id, value: m.id }));
        if (modelOptions.value.length > 0 && !formData.value.model) {
            formData.value.model = modelOptions.value[0].value;
        }
        message.success(t('models.foundModels', { count: modelOptions.value.length }));
    }
    catch (e) {
        message.error(t('models.fetchFailed') + ': ' + e.message);
    }
    finally {
        fetchingModels.value = false;
    }
}
async function handleSave() {
    if (providerType.value === 'preset' && !selectedPreset.value) {
        message.warning(t('models.selectProviderRequired'));
        return;
    }
    // Codex: 弹出授权码弹窗
    if (isCodex.value) {
        showCodexLogin.value = true;
        return;
    }
    if (!formData.value.base_url.trim()) {
        message.warning(t('models.baseUrlRequired'));
        return;
    }
    if (!formData.value.api_key.trim()) {
        message.warning(t('models.apiKeyRequired'));
        return;
    }
    if (!formData.value.model) {
        message.warning(t('models.modelRequired'));
        return;
    }
    loading.value = true;
    try {
        const providerKey = providerType.value === 'preset'
            ? selectedPreset.value
            : null;
        await modelsStore.addProvider({
            name: formData.value.name.trim(),
            base_url: formData.value.base_url.trim(),
            api_key: formData.value.api_key.trim(),
            model: formData.value.model,
            providerKey,
        });
        message.success(t('models.providerAdded'));
        emit('saved');
    }
    catch (e) {
        message.error(e.message);
    }
    finally {
        loading.value = false;
    }
}
async function handleCodexSuccess() {
    showCodexLogin.value = false;
    message.success(t('models.providerAdded'));
    emit('saved');
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
    title: (__VLS_ctx.t('models.addProvider')),
    ...{ style: ({ width: 'min(520px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading && !__VLS_ctx.showCodexLogin),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('models.addProvider')),
    ...{ style: ({ width: 'min(520px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading && !__VLS_ctx.showCodexLogin),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ afterLeave: {} },
    { onAfterLeave: (...[$event]) => {
            __VLS_ctx.emit('close');
            // @ts-ignore
            [showModal, t, loading, showCodexLogin, emit,];
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
    label: (__VLS_ctx.t('models.providerType')),
}));
const __VLS_17 = __VLS_16({
    label: (__VLS_ctx.t('models.providerType')),
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
const { default: __VLS_20 } = __VLS_18.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
let __VLS_21;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_22 = __VLS_asFunctionalComponent1(__VLS_21, new __VLS_21({
    ...{ 'onClick': {} },
    type: (__VLS_ctx.providerType === 'preset' ? 'primary' : 'default'),
    size: "small",
}));
const __VLS_23 = __VLS_22({
    ...{ 'onClick': {} },
    type: (__VLS_ctx.providerType === 'preset' ? 'primary' : 'default'),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_22));
let __VLS_26;
const __VLS_27 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.providerType = 'preset';
            // @ts-ignore
            [t, providerType, providerType,];
        } });
const { default: __VLS_28 } = __VLS_24.slots;
(__VLS_ctx.t('models.preset'));
// @ts-ignore
[t,];
var __VLS_24;
var __VLS_25;
let __VLS_29;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_30 = __VLS_asFunctionalComponent1(__VLS_29, new __VLS_29({
    ...{ 'onClick': {} },
    type: (__VLS_ctx.providerType === 'custom' ? 'primary' : 'default'),
    size: "small",
}));
const __VLS_31 = __VLS_30({
    ...{ 'onClick': {} },
    type: (__VLS_ctx.providerType === 'custom' ? 'primary' : 'default'),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_30));
let __VLS_34;
const __VLS_35 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.providerType = 'custom';
            // @ts-ignore
            [providerType, providerType,];
        } });
const { default: __VLS_36 } = __VLS_32.slots;
(__VLS_ctx.t('models.custom'));
// @ts-ignore
[t,];
var __VLS_32;
var __VLS_33;
// @ts-ignore
[];
var __VLS_18;
if (__VLS_ctx.providerType === 'preset') {
    let __VLS_37;
    /** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
    NFormItem;
    // @ts-ignore
    const __VLS_38 = __VLS_asFunctionalComponent1(__VLS_37, new __VLS_37({
        label: (__VLS_ctx.t('models.selectProvider')),
        required: true,
    }));
    const __VLS_39 = __VLS_38({
        label: (__VLS_ctx.t('models.selectProvider')),
        required: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_38));
    const { default: __VLS_42 } = __VLS_40.slots;
    let __VLS_43;
    /** @ts-ignore @type {typeof __VLS_components.NSelect} */
    NSelect;
    // @ts-ignore
    const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
        value: (__VLS_ctx.selectedPreset),
        options: (__VLS_ctx.presetOptions),
        placeholder: (__VLS_ctx.t('models.chooseProvider')),
        filterable: true,
    }));
    const __VLS_45 = __VLS_44({
        value: (__VLS_ctx.selectedPreset),
        options: (__VLS_ctx.presetOptions),
        placeholder: (__VLS_ctx.t('models.chooseProvider')),
        filterable: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_44));
    // @ts-ignore
    [t, t, providerType, selectedPreset, presetOptions,];
    var __VLS_40;
}
if (__VLS_ctx.providerType === 'custom') {
    let __VLS_48;
    /** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
    NFormItem;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent1(__VLS_48, new __VLS_48({
        label: (__VLS_ctx.t('models.name')),
    }));
    const __VLS_50 = __VLS_49({
        label: (__VLS_ctx.t('models.name')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    const { default: __VLS_53 } = __VLS_51.slots;
    let __VLS_54;
    /** @ts-ignore @type {typeof __VLS_components.NInput} */
    NInput;
    // @ts-ignore
    const __VLS_55 = __VLS_asFunctionalComponent1(__VLS_54, new __VLS_54({
        value: (__VLS_ctx.formData.name),
        placeholder: (__VLS_ctx.t('models.autoGeneratedName')),
    }));
    const __VLS_56 = __VLS_55({
        value: (__VLS_ctx.formData.name),
        placeholder: (__VLS_ctx.t('models.autoGeneratedName')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_55));
    // @ts-ignore
    [t, t, providerType, formData,];
    var __VLS_51;
}
if (!__VLS_ctx.isCodex) {
    let __VLS_59;
    /** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
    NFormItem;
    // @ts-ignore
    const __VLS_60 = __VLS_asFunctionalComponent1(__VLS_59, new __VLS_59({
        label: (__VLS_ctx.t('models.baseUrl')),
        required: true,
    }));
    const __VLS_61 = __VLS_60({
        label: (__VLS_ctx.t('models.baseUrl')),
        required: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_60));
    const { default: __VLS_64 } = __VLS_62.slots;
    let __VLS_65;
    /** @ts-ignore @type {typeof __VLS_components.NInput} */
    NInput;
    // @ts-ignore
    const __VLS_66 = __VLS_asFunctionalComponent1(__VLS_65, new __VLS_65({
        value: (__VLS_ctx.formData.base_url),
        placeholder: (__VLS_ctx.t('models.baseUrlPlaceholder')),
        disabled: (__VLS_ctx.providerType === 'preset'),
    }));
    const __VLS_67 = __VLS_66({
        value: (__VLS_ctx.formData.base_url),
        placeholder: (__VLS_ctx.t('models.baseUrlPlaceholder')),
        disabled: (__VLS_ctx.providerType === 'preset'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_66));
    // @ts-ignore
    [t, t, providerType, formData, isCodex,];
    var __VLS_62;
}
if (!__VLS_ctx.isCodex) {
    let __VLS_70;
    /** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
    NFormItem;
    // @ts-ignore
    const __VLS_71 = __VLS_asFunctionalComponent1(__VLS_70, new __VLS_70({
        label: (__VLS_ctx.t('models.apiKey')),
        required: true,
    }));
    const __VLS_72 = __VLS_71({
        label: (__VLS_ctx.t('models.apiKey')),
        required: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_71));
    const { default: __VLS_75 } = __VLS_73.slots;
    let __VLS_76;
    /** @ts-ignore @type {typeof __VLS_components.NInput} */
    NInput;
    // @ts-ignore
    const __VLS_77 = __VLS_asFunctionalComponent1(__VLS_76, new __VLS_76({
        value: (__VLS_ctx.formData.api_key),
        type: "password",
        showPasswordOn: "click",
        placeholder: (__VLS_ctx.t('models.apiKeyPlaceholder')),
        autocomplete: "off",
    }));
    const __VLS_78 = __VLS_77({
        value: (__VLS_ctx.formData.api_key),
        type: "password",
        showPasswordOn: "click",
        placeholder: (__VLS_ctx.t('models.apiKeyPlaceholder')),
        autocomplete: "off",
    }, ...__VLS_functionalComponentArgsRest(__VLS_77));
    // @ts-ignore
    [t, t, formData, isCodex,];
    var __VLS_73;
}
let __VLS_81;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_82 = __VLS_asFunctionalComponent1(__VLS_81, new __VLS_81({
    label: (__VLS_ctx.t('models.defaultModel')),
    required: true,
}));
const __VLS_83 = __VLS_82({
    label: (__VLS_ctx.t('models.defaultModel')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_82));
const { default: __VLS_86 } = __VLS_84.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
let __VLS_87;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_88 = __VLS_asFunctionalComponent1(__VLS_87, new __VLS_87({
    value: (__VLS_ctx.formData.model),
    options: (__VLS_ctx.modelOptions),
    filterable: true,
    tag: true,
    placeholder: (__VLS_ctx.t('models.selectOrInput')),
    ...{ style: {} },
}));
const __VLS_89 = __VLS_88({
    value: (__VLS_ctx.formData.model),
    options: (__VLS_ctx.modelOptions),
    filterable: true,
    tag: true,
    placeholder: (__VLS_ctx.t('models.selectOrInput')),
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_88));
if (__VLS_ctx.providerType === 'custom' || (__VLS_ctx.providerType === 'preset' && __VLS_ctx.modelOptions.length === 0)) {
    let __VLS_92;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_93 = __VLS_asFunctionalComponent1(__VLS_92, new __VLS_92({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.fetchingModels),
    }));
    const __VLS_94 = __VLS_93({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.fetchingModels),
    }, ...__VLS_functionalComponentArgsRest(__VLS_93));
    let __VLS_97;
    const __VLS_98 = ({ click: {} },
        { onClick: (__VLS_ctx.fetchModels) });
    const { default: __VLS_99 } = __VLS_95.slots;
    (__VLS_ctx.t('common.fetch'));
    // @ts-ignore
    [t, t, t, providerType, providerType, formData, modelOptions, modelOptions, fetchingModels, fetchModels,];
    var __VLS_95;
    var __VLS_96;
}
// @ts-ignore
[];
var __VLS_84;
// @ts-ignore
[];
var __VLS_12;
{
    const { footer: __VLS_100 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_101;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_102 = __VLS_asFunctionalComponent1(__VLS_101, new __VLS_101({
        ...{ 'onClick': {} },
    }));
    const __VLS_103 = __VLS_102({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_102));
    let __VLS_106;
    const __VLS_107 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_108 } = __VLS_104.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, handleClose,];
    var __VLS_104;
    var __VLS_105;
    let __VLS_109;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_110 = __VLS_asFunctionalComponent1(__VLS_109, new __VLS_109({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }));
    const __VLS_111 = __VLS_110({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_110));
    let __VLS_114;
    const __VLS_115 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSave) });
    const { default: __VLS_116 } = __VLS_112.slots;
    (__VLS_ctx.t('common.add'));
    // @ts-ignore
    [t, loading, handleSave,];
    var __VLS_112;
    var __VLS_113;
    // @ts-ignore
    [];
}
if (__VLS_ctx.showCodexLogin) {
    const __VLS_117 = CodexLoginModal;
    // @ts-ignore
    const __VLS_118 = __VLS_asFunctionalComponent1(__VLS_117, new __VLS_117({
        ...{ 'onClose': {} },
        ...{ 'onSuccess': {} },
    }));
    const __VLS_119 = __VLS_118({
        ...{ 'onClose': {} },
        ...{ 'onSuccess': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_118));
    let __VLS_122;
    const __VLS_123 = ({ close: {} },
        { onClose: (...[$event]) => {
                if (!(__VLS_ctx.showCodexLogin))
                    return;
                __VLS_ctx.showCodexLogin = false;
                // @ts-ignore
                [showCodexLogin, showCodexLogin,];
            } });
    const __VLS_124 = ({ success: {} },
        { onSuccess: (__VLS_ctx.handleCodexSuccess) });
    var __VLS_120;
    var __VLS_121;
}
// @ts-ignore
[handleCodexSuccess,];
var __VLS_3;
var __VLS_4;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
