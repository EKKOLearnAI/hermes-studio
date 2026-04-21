/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted } from 'vue';
import { NInput, NButton, NSpin, NEmpty, useMessage } from 'naive-ui';
import { useModelsStore } from '@/stores/hermes/models';
import { updateProvider } from '@/api/hermes/system';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const modelsStore = useModelsStore();
const message = useMessage();
const savingKey = ref(null);
const editKeys = ref({});
onMounted(() => {
    if (modelsStore.providers.length === 0) {
        modelsStore.fetchProviders();
    }
});
const isCustom = (provider) => provider.startsWith('custom:');
function getEditKey(provider) {
    if (!(provider in editKeys.value)) {
        const g = modelsStore.providers.find(p => p.provider === provider);
        editKeys.value[provider] = g?.api_key || '';
    }
    return editKeys.value[provider];
}
async function handleSaveApiKey(providerKey) {
    const key = getEditKey(providerKey);
    if (!key.trim()) {
        message.warning(t('settings.models.apiKeyPlaceholder'));
        return;
    }
    savingKey.value = providerKey;
    try {
        await updateProvider(providerKey, { api_key: key.trim() });
        message.success(t('settings.models.saved'));
        await modelsStore.fetchProviders();
    }
    catch (e) {
        message.error(e.message || t('settings.models.saveFailed'));
    }
    finally {
        savingKey.value = null;
    }
}
async function handleSaveCustom(providerKey) {
    const key = getEditKey(providerKey);
    savingKey.value = providerKey;
    try {
        await updateProvider(providerKey, { api_key: key.trim() });
        message.success(t('settings.models.saved'));
        await modelsStore.fetchProviders();
    }
    catch (e) {
        message.error(e.message || t('settings.models.saveFailed'));
    }
    finally {
        savingKey.value = null;
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "settings-section" },
});
/** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    show: (__VLS_ctx.modelsStore.loading),
}));
const __VLS_2 = __VLS_1({
    show: (__VLS_ctx.modelsStore.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
if (__VLS_ctx.modelsStore.providers.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-hint" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
    let __VLS_6;
    /** @ts-ignore @type {typeof __VLS_components.NEmpty} */
    NEmpty;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
        description: (__VLS_ctx.t('settings.models.noProviders')),
    }));
    const __VLS_8 = __VLS_7({
        description: (__VLS_ctx.t('settings.models.noProviders')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
}
for (const [g] of __VLS_vFor((__VLS_ctx.modelsStore.providers))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (g.provider),
        ...{ class: "provider-section" },
    });
    /** @type {__VLS_StyleScopedClasses['provider-section']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "provider-header" },
    });
    /** @type {__VLS_StyleScopedClasses['provider-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
        ...{ class: "provider-name" },
    });
    /** @type {__VLS_StyleScopedClasses['provider-name']} */ ;
    (g.label);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "type-badge" },
        ...{ class: (__VLS_ctx.isCustom(g.provider) ? 'custom' : 'builtin') },
    });
    /** @type {__VLS_StyleScopedClasses['type-badge']} */ ;
    (__VLS_ctx.isCustom(g.provider) ? __VLS_ctx.t('models.customType') : __VLS_ctx.t('models.builtIn'));
    if (!__VLS_ctx.isCustom(g.provider)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "provider-fields" },
        });
        /** @type {__VLS_StyleScopedClasses['provider-fields']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "field-row" },
        });
        /** @type {__VLS_StyleScopedClasses['field-row']} */ ;
        let __VLS_11;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_12 = __VLS_asFunctionalComponent1(__VLS_11, new __VLS_11({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getEditKey(g.provider)),
            type: "password",
            showPasswordOn: "click",
            placeholder: (__VLS_ctx.t('settings.models.apiKeyPlaceholder')),
            autocomplete: "off",
        }));
        const __VLS_13 = __VLS_12({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getEditKey(g.provider)),
            type: "password",
            showPasswordOn: "click",
            placeholder: (__VLS_ctx.t('settings.models.apiKeyPlaceholder')),
            autocomplete: "off",
        }, ...__VLS_functionalComponentArgsRest(__VLS_12));
        let __VLS_16;
        const __VLS_17 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.editKeys[g.provider] = v) });
        var __VLS_14;
        var __VLS_15;
        let __VLS_18;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
            ...{ 'onClick': {} },
            type: "primary",
            size: "small",
            loading: (__VLS_ctx.savingKey === g.provider),
        }));
        const __VLS_20 = __VLS_19({
            ...{ 'onClick': {} },
            type: "primary",
            size: "small",
            loading: (__VLS_ctx.savingKey === g.provider),
        }, ...__VLS_functionalComponentArgsRest(__VLS_19));
        let __VLS_23;
        const __VLS_24 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!(!__VLS_ctx.isCustom(g.provider)))
                        return;
                    __VLS_ctx.handleSaveApiKey(g.provider);
                    // @ts-ignore
                    [modelsStore, modelsStore, modelsStore, t, t, t, t, isCustom, isCustom, isCustom, getEditKey, editKeys, savingKey, handleSaveApiKey,];
                } });
        const { default: __VLS_25 } = __VLS_21.slots;
        (__VLS_ctx.t('settings.models.save'));
        // @ts-ignore
        [t,];
        var __VLS_21;
        var __VLS_22;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "provider-fields" },
        });
        /** @type {__VLS_StyleScopedClasses['provider-fields']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "field-row" },
        });
        /** @type {__VLS_StyleScopedClasses['field-row']} */ ;
        let __VLS_26;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_27 = __VLS_asFunctionalComponent1(__VLS_26, new __VLS_26({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getEditKey(g.provider)),
            type: "password",
            showPasswordOn: "click",
            placeholder: (__VLS_ctx.t('settings.models.apiKeyPlaceholder')),
            autocomplete: "off",
        }));
        const __VLS_28 = __VLS_27({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getEditKey(g.provider)),
            type: "password",
            showPasswordOn: "click",
            placeholder: (__VLS_ctx.t('settings.models.apiKeyPlaceholder')),
            autocomplete: "off",
        }, ...__VLS_functionalComponentArgsRest(__VLS_27));
        let __VLS_31;
        const __VLS_32 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.editKeys[g.provider] = v) });
        var __VLS_29;
        var __VLS_30;
        let __VLS_33;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
            ...{ 'onClick': {} },
            type: "primary",
            size: "small",
            loading: (__VLS_ctx.savingKey === g.provider),
        }));
        const __VLS_35 = __VLS_34({
            ...{ 'onClick': {} },
            type: "primary",
            size: "small",
            loading: (__VLS_ctx.savingKey === g.provider),
        }, ...__VLS_functionalComponentArgsRest(__VLS_34));
        let __VLS_38;
        const __VLS_39 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.isCustom(g.provider)))
                        return;
                    __VLS_ctx.handleSaveCustom(g.provider);
                    // @ts-ignore
                    [t, getEditKey, editKeys, savingKey, handleSaveCustom,];
                } });
        const { default: __VLS_40 } = __VLS_36.slots;
        (__VLS_ctx.t('settings.models.save'));
        // @ts-ignore
        [t,];
        var __VLS_36;
        var __VLS_37;
    }
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
