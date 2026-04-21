/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { onMounted } from "vue";
import { NTabs, NTabPane, NSpin, } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import DisplaySettings from "@/components/hermes/settings/DisplaySettings.vue";
import AgentSettings from "@/components/hermes/settings/AgentSettings.vue";
import MemorySettings from "@/components/hermes/settings/MemorySettings.vue";
import SessionSettings from "@/components/hermes/settings/SessionSettings.vue";
import PrivacySettings from "@/components/hermes/settings/PrivacySettings.vue";
import ModelSettings from "@/components/hermes/settings/ModelSettings.vue";
const settingsStore = useSettingsStore();
const { t } = useI18n();
onMounted(() => {
    settingsStore.fetchSettings();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "settings-view" },
});
/** @type {__VLS_StyleScopedClasses['settings-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t("settings.title"));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "settings-content" },
});
/** @type {__VLS_StyleScopedClasses['settings-content']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    show: (__VLS_ctx.settingsStore.loading || __VLS_ctx.settingsStore.saving),
    size: "large",
    description: (__VLS_ctx.t('common.loading')),
}));
const __VLS_2 = __VLS_1({
    show: (__VLS_ctx.settingsStore.loading || __VLS_ctx.settingsStore.saving),
    size: "large",
    description: (__VLS_ctx.t('common.loading')),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type {typeof __VLS_components.NTabs | typeof __VLS_components.NTabs} */
NTabs;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    type: "line",
    animated: true,
}));
const __VLS_8 = __VLS_7({
    type: "line",
    animated: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
const { default: __VLS_11 } = __VLS_9.slots;
let __VLS_12;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
    name: "display",
    tab: (__VLS_ctx.t('settings.tabs.display')),
}));
const __VLS_14 = __VLS_13({
    name: "display",
    tab: (__VLS_ctx.t('settings.tabs.display')),
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
const { default: __VLS_17 } = __VLS_15.slots;
const __VLS_18 = DisplaySettings;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({}));
const __VLS_20 = __VLS_19({}, ...__VLS_functionalComponentArgsRest(__VLS_19));
// @ts-ignore
[t, t, t, settingsStore, settingsStore,];
var __VLS_15;
let __VLS_23;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
    name: "agent",
    tab: (__VLS_ctx.t('settings.tabs.agent')),
}));
const __VLS_25 = __VLS_24({
    name: "agent",
    tab: (__VLS_ctx.t('settings.tabs.agent')),
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
const { default: __VLS_28 } = __VLS_26.slots;
const __VLS_29 = AgentSettings;
// @ts-ignore
const __VLS_30 = __VLS_asFunctionalComponent1(__VLS_29, new __VLS_29({}));
const __VLS_31 = __VLS_30({}, ...__VLS_functionalComponentArgsRest(__VLS_30));
// @ts-ignore
[t,];
var __VLS_26;
let __VLS_34;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_35 = __VLS_asFunctionalComponent1(__VLS_34, new __VLS_34({
    name: "memory",
    tab: (__VLS_ctx.t('settings.tabs.memory')),
}));
const __VLS_36 = __VLS_35({
    name: "memory",
    tab: (__VLS_ctx.t('settings.tabs.memory')),
}, ...__VLS_functionalComponentArgsRest(__VLS_35));
const { default: __VLS_39 } = __VLS_37.slots;
const __VLS_40 = MemorySettings;
// @ts-ignore
const __VLS_41 = __VLS_asFunctionalComponent1(__VLS_40, new __VLS_40({}));
const __VLS_42 = __VLS_41({}, ...__VLS_functionalComponentArgsRest(__VLS_41));
// @ts-ignore
[t,];
var __VLS_37;
let __VLS_45;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_46 = __VLS_asFunctionalComponent1(__VLS_45, new __VLS_45({
    name: "session",
    tab: (__VLS_ctx.t('settings.tabs.session')),
}));
const __VLS_47 = __VLS_46({
    name: "session",
    tab: (__VLS_ctx.t('settings.tabs.session')),
}, ...__VLS_functionalComponentArgsRest(__VLS_46));
const { default: __VLS_50 } = __VLS_48.slots;
const __VLS_51 = SessionSettings;
// @ts-ignore
const __VLS_52 = __VLS_asFunctionalComponent1(__VLS_51, new __VLS_51({}));
const __VLS_53 = __VLS_52({}, ...__VLS_functionalComponentArgsRest(__VLS_52));
// @ts-ignore
[t,];
var __VLS_48;
let __VLS_56;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_57 = __VLS_asFunctionalComponent1(__VLS_56, new __VLS_56({
    name: "privacy",
    tab: (__VLS_ctx.t('settings.tabs.privacy')),
}));
const __VLS_58 = __VLS_57({
    name: "privacy",
    tab: (__VLS_ctx.t('settings.tabs.privacy')),
}, ...__VLS_functionalComponentArgsRest(__VLS_57));
const { default: __VLS_61 } = __VLS_59.slots;
const __VLS_62 = PrivacySettings;
// @ts-ignore
const __VLS_63 = __VLS_asFunctionalComponent1(__VLS_62, new __VLS_62({}));
const __VLS_64 = __VLS_63({}, ...__VLS_functionalComponentArgsRest(__VLS_63));
// @ts-ignore
[t,];
var __VLS_59;
let __VLS_67;
/** @ts-ignore @type {typeof __VLS_components.NTabPane | typeof __VLS_components.NTabPane} */
NTabPane;
// @ts-ignore
const __VLS_68 = __VLS_asFunctionalComponent1(__VLS_67, new __VLS_67({
    name: "models",
    tab: (__VLS_ctx.t('settings.tabs.models')),
}));
const __VLS_69 = __VLS_68({
    name: "models",
    tab: (__VLS_ctx.t('settings.tabs.models')),
}, ...__VLS_functionalComponentArgsRest(__VLS_68));
const { default: __VLS_72 } = __VLS_70.slots;
const __VLS_73 = ModelSettings;
// @ts-ignore
const __VLS_74 = __VLS_asFunctionalComponent1(__VLS_73, new __VLS_73({}));
const __VLS_75 = __VLS_74({}, ...__VLS_functionalComponentArgsRest(__VLS_74));
// @ts-ignore
[t,];
var __VLS_70;
// @ts-ignore
[];
var __VLS_9;
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
