/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { computed, onMounted } from 'vue';
import { NSelect, useMessage } from 'naive-ui';
import { useProfilesStore } from '@/stores/hermes/profiles';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const message = useMessage();
const profilesStore = useProfilesStore();
const options = computed(() => profilesStore.profiles.map(p => ({
    label: p.name,
    value: p.name,
})));
const activeName = computed(() => profilesStore.activeProfile?.name ?? '');
function handleChange(value) {
    if (typeof value === 'string' && value !== activeName.value) {
        profilesStore.switchProfile(value).then(ok => {
            if (ok) {
                message.success(t('profiles.switchSuccess', { name: value }));
                window.location.reload();
            }
        });
    }
}
onMounted(() => {
    if (profilesStore.profiles.length === 0) {
        profilesStore.fetchProfiles();
    }
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "profile-selector" },
});
/** @type {__VLS_StyleScopedClasses['profile-selector']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "selector-label" },
});
/** @type {__VLS_StyleScopedClasses['selector-label']} */ ;
(__VLS_ctx.t('sidebar.profiles'));
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.activeName),
    options: (__VLS_ctx.options),
    loading: (__VLS_ctx.profilesStore.switching),
    size: "small",
}));
const __VLS_2 = __VLS_1({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.activeName),
    options: (__VLS_ctx.options),
    loading: (__VLS_ctx.profilesStore.switching),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ 'update:value': {} },
    { 'onUpdate:value': (__VLS_ctx.handleChange) });
var __VLS_3;
var __VLS_4;
// @ts-ignore
[t, activeName, options, profilesStore, handleChange,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
