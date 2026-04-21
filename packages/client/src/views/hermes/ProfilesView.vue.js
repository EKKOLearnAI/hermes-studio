/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted } from 'vue';
import { NButton, NSpin } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import ProfilesPanel from '@/components/hermes/profiles/ProfilesPanel.vue';
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue';
import ProfileRenameModal from '@/components/hermes/profiles/ProfileRenameModal.vue';
import ProfileImportModal from '@/components/hermes/profiles/ProfileImportModal.vue';
import { useProfilesStore } from '@/stores/hermes/profiles';
const { t } = useI18n();
const profilesStore = useProfilesStore();
const showCreateModal = ref(false);
const showImportModal = ref(false);
const renamingProfile = ref(null);
onMounted(() => {
    profilesStore.fetchProfiles();
});
function handleCreated() {
    showCreateModal.value = false;
}
function handleRenamed() {
    renamingProfile.value = null;
}
function handleImported() {
    showImportModal.value = false;
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "profiles-view" },
});
/** @type {__VLS_StyleScopedClasses['profiles-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('profiles.title'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-actions" },
});
/** @type {__VLS_StyleScopedClasses['header-actions']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    size: "small",
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.showImportModal = true;
            // @ts-ignore
            [t, showImportModal,];
        } });
const { default: __VLS_7 } = __VLS_3.slots;
{
    const { icon: __VLS_8 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "17 8 12 3 7 8",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "3",
        x2: "12",
        y2: "15",
    });
    // @ts-ignore
    [];
}
(__VLS_ctx.t('profiles.import'));
// @ts-ignore
[t,];
var __VLS_3;
var __VLS_4;
let __VLS_9;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    ...{ 'onClick': {} },
    type: "primary",
    size: "small",
}));
const __VLS_11 = __VLS_10({
    ...{ 'onClick': {} },
    type: "primary",
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
let __VLS_14;
const __VLS_15 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.showCreateModal = true;
            // @ts-ignore
            [showCreateModal,];
        } });
const { default: __VLS_16 } = __VLS_12.slots;
{
    const { icon: __VLS_17 } = __VLS_12.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        'stroke-linecap': "round",
        'stroke-linejoin': "round",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "5",
        x2: "12",
        y2: "19",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "5",
        y1: "12",
        x2: "19",
        y2: "12",
    });
    // @ts-ignore
    [];
}
(__VLS_ctx.t('profiles.create'));
// @ts-ignore
[t,];
var __VLS_12;
var __VLS_13;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "profiles-content" },
});
/** @type {__VLS_StyleScopedClasses['profiles-content']} */ ;
let __VLS_18;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
    show: (__VLS_ctx.profilesStore.loading && __VLS_ctx.profilesStore.profiles.length === 0),
}));
const __VLS_20 = __VLS_19({
    show: (__VLS_ctx.profilesStore.loading && __VLS_ctx.profilesStore.profiles.length === 0),
}, ...__VLS_functionalComponentArgsRest(__VLS_19));
const { default: __VLS_23 } = __VLS_21.slots;
const __VLS_24 = ProfilesPanel;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent1(__VLS_24, new __VLS_24({
    ...{ 'onRename': {} },
}));
const __VLS_26 = __VLS_25({
    ...{ 'onRename': {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
let __VLS_29;
const __VLS_30 = ({ rename: {} },
    { onRename: (...[$event]) => {
            __VLS_ctx.renamingProfile = $event;
            // @ts-ignore
            [profilesStore, profilesStore, renamingProfile,];
        } });
var __VLS_27;
var __VLS_28;
// @ts-ignore
[];
var __VLS_21;
if (__VLS_ctx.showCreateModal) {
    const __VLS_31 = ProfileCreateModal;
    // @ts-ignore
    const __VLS_32 = __VLS_asFunctionalComponent1(__VLS_31, new __VLS_31({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }));
    const __VLS_33 = __VLS_32({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_32));
    let __VLS_36;
    const __VLS_37 = ({ close: {} },
        { onClose: (...[$event]) => {
                if (!(__VLS_ctx.showCreateModal))
                    return;
                __VLS_ctx.showCreateModal = false;
                // @ts-ignore
                [showCreateModal, showCreateModal,];
            } });
    const __VLS_38 = ({ saved: {} },
        { onSaved: (__VLS_ctx.handleCreated) });
    var __VLS_34;
    var __VLS_35;
}
if (__VLS_ctx.renamingProfile) {
    const __VLS_39 = ProfileRenameModal;
    // @ts-ignore
    const __VLS_40 = __VLS_asFunctionalComponent1(__VLS_39, new __VLS_39({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
        profileName: (__VLS_ctx.renamingProfile),
    }));
    const __VLS_41 = __VLS_40({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
        profileName: (__VLS_ctx.renamingProfile),
    }, ...__VLS_functionalComponentArgsRest(__VLS_40));
    let __VLS_44;
    const __VLS_45 = ({ close: {} },
        { onClose: (...[$event]) => {
                if (!(__VLS_ctx.renamingProfile))
                    return;
                __VLS_ctx.renamingProfile = null;
                // @ts-ignore
                [renamingProfile, renamingProfile, renamingProfile, handleCreated,];
            } });
    const __VLS_46 = ({ saved: {} },
        { onSaved: (__VLS_ctx.handleRenamed) });
    var __VLS_42;
    var __VLS_43;
}
if (__VLS_ctx.showImportModal) {
    const __VLS_47 = ProfileImportModal;
    // @ts-ignore
    const __VLS_48 = __VLS_asFunctionalComponent1(__VLS_47, new __VLS_47({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }));
    const __VLS_49 = __VLS_48({
        ...{ 'onClose': {} },
        ...{ 'onSaved': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_48));
    let __VLS_52;
    const __VLS_53 = ({ close: {} },
        { onClose: (...[$event]) => {
                if (!(__VLS_ctx.showImportModal))
                    return;
                __VLS_ctx.showImportModal = false;
                // @ts-ignore
                [showImportModal, showImportModal, handleRenamed,];
            } });
    const __VLS_54 = ({ saved: {} },
        { onSaved: (__VLS_ctx.handleImported) });
    var __VLS_50;
    var __VLS_51;
}
// @ts-ignore
[handleImported,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
