/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { NSwitch, NSelect, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/hermes/settings';
import { useTheme } from '@/composables/useTheme';
import SettingRow from './SettingRow.vue';
const settingsStore = useSettingsStore();
const message = useMessage();
const { t } = useI18n();
const { mode, setMode } = useTheme();
const themeOptions = [
    { label: t('settings.display.themeLight'), value: 'light' },
    { label: t('settings.display.themeDark'), value: 'dark' },
    { label: t('settings.display.themeSystem'), value: 'system' },
];
async function save(values) {
    try {
        await settingsStore.saveSection('display', values);
        message.success(t('settings.saved'));
    }
    catch (err) {
        message.error(t('settings.saveFailed'));
    }
}
function handleThemeChange(val) {
    const m = val;
    setMode(m);
    save({ skin: m });
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
    label: (__VLS_ctx.t('settings.display.theme')),
    hint: (__VLS_ctx.t('settings.display.themeHint')),
}));
const __VLS_2 = __VLS_1({
    label: (__VLS_ctx.t('settings.display.theme')),
    hint: (__VLS_ctx.t('settings.display.themeHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.mode),
    options: (__VLS_ctx.themeOptions),
    size: "small",
    consistentMenuWidth: (false),
    ...{ class: "input-sm" },
}));
const __VLS_8 = __VLS_7({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.mode),
    options: (__VLS_ctx.themeOptions),
    size: "small",
    consistentMenuWidth: (false),
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
let __VLS_11;
const __VLS_12 = ({ 'update:value': {} },
    { 'onUpdate:value': (__VLS_ctx.handleThemeChange) });
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_9;
var __VLS_10;
// @ts-ignore
[t, t, mode, themeOptions, handleThemeChange,];
var __VLS_3;
const __VLS_13 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
    label: (__VLS_ctx.t('settings.display.streaming')),
    hint: (__VLS_ctx.t('settings.display.streamingHint')),
}));
const __VLS_15 = __VLS_14({
    label: (__VLS_ctx.t('settings.display.streaming')),
    hint: (__VLS_ctx.t('settings.display.streamingHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_14));
const { default: __VLS_18 } = __VLS_16.slots;
let __VLS_19;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent1(__VLS_19, new __VLS_19({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.streaming),
}));
const __VLS_21 = __VLS_20({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.streaming),
}, ...__VLS_functionalComponentArgsRest(__VLS_20));
let __VLS_24;
const __VLS_25 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ streaming: v })) });
var __VLS_22;
var __VLS_23;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_16;
const __VLS_26 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_27 = __VLS_asFunctionalComponent1(__VLS_26, new __VLS_26({
    label: (__VLS_ctx.t('settings.display.compact')),
    hint: (__VLS_ctx.t('settings.display.compactHint')),
}));
const __VLS_28 = __VLS_27({
    label: (__VLS_ctx.t('settings.display.compact')),
    hint: (__VLS_ctx.t('settings.display.compactHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_27));
const { default: __VLS_31 } = __VLS_29.slots;
let __VLS_32;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.compact),
}));
const __VLS_34 = __VLS_33({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.compact),
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
let __VLS_37;
const __VLS_38 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ compact: v })) });
var __VLS_35;
var __VLS_36;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_29;
const __VLS_39 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_40 = __VLS_asFunctionalComponent1(__VLS_39, new __VLS_39({
    label: (__VLS_ctx.t('settings.display.showReasoning')),
    hint: (__VLS_ctx.t('settings.display.showReasoningHint')),
}));
const __VLS_41 = __VLS_40({
    label: (__VLS_ctx.t('settings.display.showReasoning')),
    hint: (__VLS_ctx.t('settings.display.showReasoningHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_40));
const { default: __VLS_44 } = __VLS_42.slots;
let __VLS_45;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_46 = __VLS_asFunctionalComponent1(__VLS_45, new __VLS_45({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.show_reasoning),
}));
const __VLS_47 = __VLS_46({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.show_reasoning),
}, ...__VLS_functionalComponentArgsRest(__VLS_46));
let __VLS_50;
const __VLS_51 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ show_reasoning: v })) });
var __VLS_48;
var __VLS_49;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_42;
const __VLS_52 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent1(__VLS_52, new __VLS_52({
    label: (__VLS_ctx.t('settings.display.showCost')),
    hint: (__VLS_ctx.t('settings.display.showCostHint')),
}));
const __VLS_54 = __VLS_53({
    label: (__VLS_ctx.t('settings.display.showCost')),
    hint: (__VLS_ctx.t('settings.display.showCostHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_53));
const { default: __VLS_57 } = __VLS_55.slots;
let __VLS_58;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_59 = __VLS_asFunctionalComponent1(__VLS_58, new __VLS_58({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.show_cost),
}));
const __VLS_60 = __VLS_59({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.show_cost),
}, ...__VLS_functionalComponentArgsRest(__VLS_59));
let __VLS_63;
const __VLS_64 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ show_cost: v })) });
var __VLS_61;
var __VLS_62;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_55;
const __VLS_65 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_66 = __VLS_asFunctionalComponent1(__VLS_65, new __VLS_65({
    label: (__VLS_ctx.t('settings.display.inlineDiffs')),
    hint: (__VLS_ctx.t('settings.display.inlineDiffsHint')),
}));
const __VLS_67 = __VLS_66({
    label: (__VLS_ctx.t('settings.display.inlineDiffs')),
    hint: (__VLS_ctx.t('settings.display.inlineDiffsHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_66));
const { default: __VLS_70 } = __VLS_68.slots;
let __VLS_71;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_72 = __VLS_asFunctionalComponent1(__VLS_71, new __VLS_71({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.inline_diffs),
}));
const __VLS_73 = __VLS_72({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.inline_diffs),
}, ...__VLS_functionalComponentArgsRest(__VLS_72));
let __VLS_76;
const __VLS_77 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ inline_diffs: v })) });
var __VLS_74;
var __VLS_75;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_68;
const __VLS_78 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_79 = __VLS_asFunctionalComponent1(__VLS_78, new __VLS_78({
    label: (__VLS_ctx.t('settings.display.bellOnComplete')),
    hint: (__VLS_ctx.t('settings.display.bellOnCompleteHint')),
}));
const __VLS_80 = __VLS_79({
    label: (__VLS_ctx.t('settings.display.bellOnComplete')),
    hint: (__VLS_ctx.t('settings.display.bellOnCompleteHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_79));
const { default: __VLS_83 } = __VLS_81.slots;
let __VLS_84;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_85 = __VLS_asFunctionalComponent1(__VLS_84, new __VLS_84({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.bell_on_complete),
}));
const __VLS_86 = __VLS_85({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.bell_on_complete),
}, ...__VLS_functionalComponentArgsRest(__VLS_85));
let __VLS_89;
const __VLS_90 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ bell_on_complete: v })) });
var __VLS_87;
var __VLS_88;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_81;
const __VLS_91 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_92 = __VLS_asFunctionalComponent1(__VLS_91, new __VLS_91({
    label: (__VLS_ctx.t('settings.display.busyInputMode')),
    hint: (__VLS_ctx.t('settings.display.busyInputModeHint')),
}));
const __VLS_93 = __VLS_92({
    label: (__VLS_ctx.t('settings.display.busyInputMode')),
    hint: (__VLS_ctx.t('settings.display.busyInputModeHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_92));
const { default: __VLS_96 } = __VLS_94.slots;
let __VLS_97;
/** @ts-ignore @type {typeof __VLS_components.NSwitch} */
NSwitch;
// @ts-ignore
const __VLS_98 = __VLS_asFunctionalComponent1(__VLS_97, new __VLS_97({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.busy_input_mode === 'interrupt'),
}));
const __VLS_99 = __VLS_98({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.display.busy_input_mode === 'interrupt'),
}, ...__VLS_functionalComponentArgsRest(__VLS_98));
let __VLS_102;
const __VLS_103 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ busy_input_mode: v ? 'interrupt' : 'off' })) });
var __VLS_100;
var __VLS_101;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_94;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
