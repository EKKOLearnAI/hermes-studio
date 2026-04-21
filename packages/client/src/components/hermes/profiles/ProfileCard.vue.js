/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed } from 'vue';
import { NButton, NTag, NSpin, useMessage, useDialog } from 'naive-ui';
import { useProfilesStore } from '@/stores/hermes/profiles';
import { useI18n } from 'vue-i18n';
const props = defineProps();
const emit = defineEmits();
const { t } = useI18n();
const profilesStore = useProfilesStore();
const message = useMessage();
const dialog = useDialog();
const expanded = ref(false);
const detailLoading = ref(false);
const exporting = ref(false);
const switching = ref(false);
const detail = ref(null);
const isDefault = computed(() => props.profile.name === 'default');
async function toggleDetail() {
    if (expanded.value) {
        expanded.value = false;
        return;
    }
    expanded.value = true;
    detailLoading.value = true;
    try {
        detail.value = await profilesStore.fetchProfileDetail(props.profile.name);
    }
    finally {
        detailLoading.value = false;
    }
}
async function handleSwitch() {
    switching.value = true;
    try {
        const ok = await profilesStore.switchProfile(props.profile.name);
        if (ok) {
            window.location.reload();
        }
        else {
            message.error(t('profiles.switchFailed'));
        }
    }
    finally {
        switching.value = false;
    }
}
function handleDelete() {
    dialog.warning({
        title: t('profiles.delete'),
        content: t('profiles.deleteConfirm', { name: props.profile.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
            const ok = await profilesStore.deleteProfile(props.profile.name);
            if (ok) {
                message.success(t('profiles.deleteSuccess'));
            }
            else {
                message.error(t('profiles.deleteFailed'));
            }
        },
    });
}
async function handleExport() {
    exporting.value = true;
    try {
        const ok = await profilesStore.exportProfile(props.profile.name);
        if (ok) {
            message.success(t('profiles.exportSuccess'));
        }
        else {
            message.error(t('profiles.exportFailed'));
        }
    }
    finally {
        exporting.value = false;
    }
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
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "profile-card" },
    ...{ class: ({ active: __VLS_ctx.profile.active }) },
});
/** @type {__VLS_StyleScopedClasses['profile-card']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-header" },
});
/** @type {__VLS_StyleScopedClasses['card-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "profile-name" },
});
/** @type {__VLS_StyleScopedClasses['profile-name']} */ ;
(__VLS_ctx.profile.name);
if (__VLS_ctx.profile.active) {
    let __VLS_0;
    /** @ts-ignore @type {typeof __VLS_components.NTag | typeof __VLS_components.NTag} */
    NTag;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        size: "tiny",
        type: "success",
        bordered: (false),
    }));
    const __VLS_2 = __VLS_1({
        size: "tiny",
        type: "success",
        bordered: (false),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    const { default: __VLS_5 } = __VLS_3.slots;
    (__VLS_ctx.t('profiles.active'));
    // @ts-ignore
    [profile, profile, profile, t,];
    var __VLS_3;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-body" },
});
/** @type {__VLS_StyleScopedClasses['card-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('profiles.model'));
__VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
    ...{ class: "info-value mono" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.profile.model);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('profiles.gateway'));
__VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
    ...{ class: "info-value mono" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.profile.gateway);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (__VLS_ctx.toggleDetail) },
    ...{ class: "card-detail-toggle" },
});
/** @type {__VLS_StyleScopedClasses['card-detail-toggle']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
    'stroke-linecap': "round",
    'stroke-linejoin': "round",
    ...{ class: "toggle-icon" },
    ...{ class: ({ expanded: __VLS_ctx.expanded }) },
});
/** @type {__VLS_StyleScopedClasses['toggle-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['expanded']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
    points: "6 9 12 15 18 9",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "toggle-text" },
});
/** @type {__VLS_StyleScopedClasses['toggle-text']} */ ;
(__VLS_ctx.expanded ? __VLS_ctx.t('common.collapse') : __VLS_ctx.t('common.expand'));
if (__VLS_ctx.expanded) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-detail" },
    });
    /** @type {__VLS_StyleScopedClasses['card-detail']} */ ;
    let __VLS_6;
    /** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
    NSpin;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
        show: (__VLS_ctx.detailLoading),
        size: "small",
    }));
    const __VLS_8 = __VLS_7({
        show: (__VLS_ctx.detailLoading),
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    const { default: __VLS_11 } = __VLS_9.slots;
    if (__VLS_ctx.detail) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "info-row" },
        });
        /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-label" },
        });
        /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
        (__VLS_ctx.t('profiles.provider'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-value" },
        });
        /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
        (__VLS_ctx.detail.provider);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "info-row" },
        });
        /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-label" },
        });
        /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
        (__VLS_ctx.t('profiles.path'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
            ...{ class: "info-value mono detail-path" },
        });
        /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        /** @type {__VLS_StyleScopedClasses['detail-path']} */ ;
        (__VLS_ctx.detail.path);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "info-row" },
        });
        /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-label" },
        });
        /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
        (__VLS_ctx.t('profiles.skills'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-value" },
        });
        /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
        (__VLS_ctx.detail.skills);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "info-row" },
        });
        /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-label" },
        });
        /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
        (__VLS_ctx.t('profiles.hasEnv'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-value" },
        });
        /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
        (__VLS_ctx.detail.hasEnv ? 'Yes' : 'No');
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "info-row" },
        });
        /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-label" },
        });
        /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
        (__VLS_ctx.t('profiles.hasSoulMd'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "info-value" },
        });
        /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
        (__VLS_ctx.detail.hasSoulMd ? 'Yes' : 'No');
    }
    // @ts-ignore
    [profile, profile, t, t, t, t, t, t, t, t, t, toggleDetail, expanded, expanded, expanded, detailLoading, detail, detail, detail, detail, detail, detail,];
    var __VLS_9;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-actions" },
});
/** @type {__VLS_StyleScopedClasses['card-actions']} */ ;
if (!__VLS_ctx.profile.active) {
    let __VLS_12;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
        ...{ 'onClick': {} },
        size: "tiny",
        loading: (__VLS_ctx.switching),
        quaternary: true,
        type: "primary",
    }));
    const __VLS_14 = __VLS_13({
        ...{ 'onClick': {} },
        size: "tiny",
        loading: (__VLS_ctx.switching),
        quaternary: true,
        type: "primary",
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    let __VLS_17;
    const __VLS_18 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSwitch) });
    const { default: __VLS_19 } = __VLS_15.slots;
    (__VLS_ctx.t('profiles.switchTo'));
    // @ts-ignore
    [profile, t, switching, handleSwitch,];
    var __VLS_15;
    var __VLS_16;
}
let __VLS_20;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent1(__VLS_20, new __VLS_20({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
    disabled: (__VLS_ctx.isDefault || __VLS_ctx.profile.active),
}));
const __VLS_22 = __VLS_21({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
    disabled: (__VLS_ctx.isDefault || __VLS_ctx.profile.active),
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
let __VLS_25;
const __VLS_26 = ({ click: {} },
    { onClick: (__VLS_ctx.handleDelete) });
const { default: __VLS_27 } = __VLS_23.slots;
(__VLS_ctx.t('common.delete'));
// @ts-ignore
[profile, t, isDefault, handleDelete,];
var __VLS_23;
var __VLS_24;
let __VLS_28;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    loading: (__VLS_ctx.exporting),
}));
const __VLS_30 = __VLS_29({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    loading: (__VLS_ctx.exporting),
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
let __VLS_33;
const __VLS_34 = ({ click: {} },
    { onClick: (__VLS_ctx.handleExport) });
const { default: __VLS_35 } = __VLS_31.slots;
(__VLS_ctx.t('profiles.export'));
// @ts-ignore
[t, exporting, handleExport,];
var __VLS_31;
var __VLS_32;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
