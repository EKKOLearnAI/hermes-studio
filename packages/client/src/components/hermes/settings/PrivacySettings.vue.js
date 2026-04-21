/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { NSwitch, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/hermes/settings';
import SettingRow from './SettingRow.vue';
const settingsStore = useSettingsStore();
const message = useMessage();
const { t } = useI18n();
async function save(values) {
    try {
        await settingsStore.saveSection('privacy', values);
        message.success(t('settings.saved'));
    }
    catch (err) {
        message.error(t('settings.saveFailed'));
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
const __VLS_0 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    label: (__VLS_ctx.t('settings.privacy.redactPii')),
    hint: (__VLS_ctx.t('settings.privacy.redactPiiHint')),
}));
const __VLS_2 = __VLS_1({
    label: (__VLS_ctx.t('settings.privacy.redactPii')),
    hint: (__VLS_ctx.t('settings.privacy.redactPiiHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.privacy.redact_pii),
}));
const __VLS_8 = __VLS_7({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.privacy.redact_pii),
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
let __VLS_11;
const __VLS_12 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ redact_pii: v })) });
var __VLS_9;
var __VLS_10;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
