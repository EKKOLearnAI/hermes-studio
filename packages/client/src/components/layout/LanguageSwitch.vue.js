/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { useI18n } from 'vue-i18n';
import { NSelect } from 'naive-ui';
const { locale } = useI18n();
const options = [
    { label: '中文', value: 'zh' },
    { label: 'English', value: 'en' },
    { label: '日本語', value: 'ja' },
    { label: '한국어', value: 'ko' },
    { label: 'Français', value: 'fr' },
    { label: 'Español', value: 'es' },
    { label: 'Deutsch', value: 'de' },
    { label: 'Português', value: 'pt' },
];
function handleChange(val) {
    locale.value = val;
    localStorage.setItem('hermes_locale', val);
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.locale),
    options: (__VLS_ctx.options),
    size: "tiny",
    consistentMenuWidth: (false),
    ...{ class: "input-sm" },
}));
const __VLS_2 = __VLS_1({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.locale),
    options: (__VLS_ctx.options),
    size: "tiny",
    consistentMenuWidth: (false),
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ 'update:value': {} },
    { 'onUpdate:value': (__VLS_ctx.handleChange) });
var __VLS_7 = {};
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_3;
var __VLS_4;
// @ts-ignore
[locale, options, handleChange,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
