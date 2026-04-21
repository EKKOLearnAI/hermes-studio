/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { NInputNumber, NSelect, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/hermes/settings';
import SettingRow from './SettingRow.vue';
const settingsStore = useSettingsStore();
const message = useMessage();
const { t } = useI18n();
async function save(values) {
    try {
        await settingsStore.saveSection('session_reset', values);
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
    label: (__VLS_ctx.t('settings.session.mode')),
    hint: (__VLS_ctx.t('settings.session.modeHint')),
}));
const __VLS_2 = __VLS_1({
    label: (__VLS_ctx.t('settings.session.mode')),
    hint: (__VLS_ctx.t('settings.session.modeHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.mode || 'both'),
    options: ([
        { label: __VLS_ctx.t('settings.session.modeBoth'), value: 'both' },
        { label: __VLS_ctx.t('settings.session.modeIdle'), value: 'idle' },
        { label: __VLS_ctx.t('settings.session.modeHourly'), value: 'hourly' },
    ]),
    size: "small",
    ...{ class: "input-md" },
}));
const __VLS_8 = __VLS_7({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.mode || 'both'),
    options: ([
        { label: __VLS_ctx.t('settings.session.modeBoth'), value: 'both' },
        { label: __VLS_ctx.t('settings.session.modeIdle'), value: 'idle' },
        { label: __VLS_ctx.t('settings.session.modeHourly'), value: 'hourly' },
    ]),
    size: "small",
    ...{ class: "input-md" },
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
let __VLS_11;
const __VLS_12 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.save({ mode: v })) });
/** @type {__VLS_StyleScopedClasses['input-md']} */ ;
var __VLS_9;
var __VLS_10;
// @ts-ignore
[t, t, t, t, t, settingsStore, save,];
var __VLS_3;
const __VLS_13 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
    label: (__VLS_ctx.t('settings.session.idleMinutes')),
    hint: (__VLS_ctx.t('settings.session.idleMinutesHint')),
}));
const __VLS_15 = __VLS_14({
    label: (__VLS_ctx.t('settings.session.idleMinutes')),
    hint: (__VLS_ctx.t('settings.session.idleMinutesHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_14));
const { default: __VLS_18 } = __VLS_16.slots;
let __VLS_19;
/** @ts-ignore @type {typeof __VLS_components.NInputNumber} */
NInputNumber;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent1(__VLS_19, new __VLS_19({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.idle_minutes),
    min: (10),
    max: (10080),
    step: (30),
    size: "small",
    ...{ class: "input-sm" },
}));
const __VLS_21 = __VLS_20({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.idle_minutes),
    min: (10),
    max: (10080),
    step: (30),
    size: "small",
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_20));
let __VLS_24;
const __VLS_25 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => v != null && __VLS_ctx.save({ idle_minutes: v })) });
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_22;
var __VLS_23;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_16;
const __VLS_26 = SettingRow || SettingRow;
// @ts-ignore
const __VLS_27 = __VLS_asFunctionalComponent1(__VLS_26, new __VLS_26({
    label: (__VLS_ctx.t('settings.session.atHour')),
    hint: (__VLS_ctx.t('settings.session.atHourHint')),
}));
const __VLS_28 = __VLS_27({
    label: (__VLS_ctx.t('settings.session.atHour')),
    hint: (__VLS_ctx.t('settings.session.atHourHint')),
}, ...__VLS_functionalComponentArgsRest(__VLS_27));
const { default: __VLS_31 } = __VLS_29.slots;
let __VLS_32;
/** @ts-ignore @type {typeof __VLS_components.NInputNumber} */
NInputNumber;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.at_hour),
    min: (0),
    max: (23),
    step: (1),
    size: "small",
    ...{ class: "input-sm" },
}));
const __VLS_34 = __VLS_33({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.settingsStore.sessionReset.at_hour),
    min: (0),
    max: (23),
    step: (1),
    size: "small",
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
let __VLS_37;
const __VLS_38 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => v != null && __VLS_ctx.save({ at_hour: v })) });
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_35;
var __VLS_36;
// @ts-ignore
[t, t, settingsStore, save,];
var __VLS_29;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
