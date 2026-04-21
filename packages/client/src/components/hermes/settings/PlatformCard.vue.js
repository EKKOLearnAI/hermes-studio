/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed } from 'vue';
import { NTag } from 'naive-ui';
import { useI18n } from 'vue-i18n';
const props = defineProps();
const expanded = ref(true);
const { t } = useI18n();
const configured = computed(() => {
    const creds = props.credentials;
    if (!creds)
        return false;
    const keys = ['token', 'api_key', 'app_id', 'client_id', 'secret', 'app_secret', 'client_secret', 'access_token', 'bot_id', 'account_id', 'enabled'];
    // Check top-level and nested extra.*
    const targets = [creds, creds.extra].filter(Boolean);
    return targets.some(obj => keys.some(key => {
        const val = obj[key];
        return val !== undefined && val !== null && val !== '' && val !== false;
    }));
});
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['expanded']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "platform-card" },
    ...{ class: ({ configured: __VLS_ctx.configured }) },
});
/** @type {__VLS_StyleScopedClasses['platform-card']} */ ;
/** @type {__VLS_StyleScopedClasses['configured']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.expanded = !__VLS_ctx.expanded;
            // @ts-ignore
            [configured, expanded, expanded,];
        } },
    ...{ class: "platform-card-header" },
});
/** @type {__VLS_StyleScopedClasses['platform-card-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "platform-info" },
});
/** @type {__VLS_StyleScopedClasses['platform-info']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span)({
    ...{ class: "platform-icon" },
});
__VLS_asFunctionalDirective(__VLS_directives.vHtml, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.icon) }, null, null);
/** @type {__VLS_StyleScopedClasses['platform-icon']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "platform-name" },
});
/** @type {__VLS_StyleScopedClasses['platform-name']} */ ;
(__VLS_ctx.name);
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NTag | typeof __VLS_components.NTag} */
NTag;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    type: (__VLS_ctx.configured ? 'success' : 'default'),
    size: "small",
    round: true,
}));
const __VLS_2 = __VLS_1({
    type: (__VLS_ctx.configured ? 'success' : 'default'),
    size: "small",
    round: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
(__VLS_ctx.configured ? __VLS_ctx.t('common.configured') : __VLS_ctx.t('common.notConfigured'));
// @ts-ignore
[configured, configured, icon, name, t, t,];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "expand-icon" },
    ...{ class: ({ expanded: __VLS_ctx.expanded }) },
});
/** @type {__VLS_StyleScopedClasses['expand-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['expanded']} */ ;
if (__VLS_ctx.expanded) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "platform-card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['platform-card-body']} */ ;
    var __VLS_6 = {};
}
// @ts-ignore
var __VLS_7 = __VLS_6;
// @ts-ignore
[expanded, expanded,];
const __VLS_base = (await import('vue')).defineComponent({
    __typeProps: {},
});
const __VLS_export = {};
export default {};
