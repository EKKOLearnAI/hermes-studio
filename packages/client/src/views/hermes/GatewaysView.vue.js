/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { onMounted } from 'vue';
import { NSpin, NButton, NTag, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useGatewayStore } from '@/stores/hermes/gateways';
const { t } = useI18n();
const message = useMessage();
const gatewayStore = useGatewayStore();
onMounted(() => {
    gatewayStore.fetchStatus();
});
async function handleToggle(name, running) {
    try {
        if (running) {
            await gatewayStore.stop(name);
            message.success(`${t('gateways.stopped')}: ${name}`);
        }
        else {
            await gatewayStore.start(name);
            message.success(`${t('gateways.started')}: ${name}`);
        }
    }
    catch (err) {
        message.error(err.message);
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "gateways-view" },
});
/** @type {__VLS_StyleScopedClasses['gateways-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('gateways.title'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "gateways-content" },
});
/** @type {__VLS_StyleScopedClasses['gateways-content']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    show: (__VLS_ctx.gatewayStore.loading),
    size: "large",
}));
const __VLS_2 = __VLS_1({
    show: (__VLS_ctx.gatewayStore.loading),
    size: "large",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
if (__VLS_ctx.gatewayStore.gateways.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-state" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
    (__VLS_ctx.t('common.noData'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "gateway-list" },
    });
    /** @type {__VLS_StyleScopedClasses['gateway-list']} */ ;
    for (const [gw] of __VLS_vFor((__VLS_ctx.gatewayStore.gateways))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (gw.profile),
            ...{ class: "gateway-card" },
        });
        /** @type {__VLS_StyleScopedClasses['gateway-card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "gateway-info" },
        });
        /** @type {__VLS_StyleScopedClasses['gateway-info']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "gateway-name" },
        });
        /** @type {__VLS_StyleScopedClasses['gateway-name']} */ ;
        (gw.profile);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "gateway-meta" },
        });
        /** @type {__VLS_StyleScopedClasses['gateway-meta']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta-item" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-item']} */ ;
        (gw.host);
        (gw.port);
        if (gw.pid) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "meta-item" },
            });
            /** @type {__VLS_StyleScopedClasses['meta-item']} */ ;
            (gw.pid);
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "gateway-actions" },
        });
        /** @type {__VLS_StyleScopedClasses['gateway-actions']} */ ;
        let __VLS_6;
        /** @ts-ignore @type {typeof __VLS_components.NTag | typeof __VLS_components.NTag} */
        NTag;
        // @ts-ignore
        const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
            type: (gw.running ? 'success' : 'default'),
            size: "small",
            round: true,
        }));
        const __VLS_8 = __VLS_7({
            type: (gw.running ? 'success' : 'default'),
            size: "small",
            round: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_7));
        const { default: __VLS_11 } = __VLS_9.slots;
        (gw.running ? __VLS_ctx.t('gateways.running') : __VLS_ctx.t('gateways.stopped'));
        // @ts-ignore
        [t, t, t, t, gatewayStore, gatewayStore, gatewayStore,];
        var __VLS_9;
        let __VLS_12;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
            ...{ 'onClick': {} },
            size: "small",
            type: (gw.running ? 'warning' : 'primary'),
            round: true,
        }));
        const __VLS_14 = __VLS_13({
            ...{ 'onClick': {} },
            size: "small",
            type: (gw.running ? 'warning' : 'primary'),
            round: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_13));
        let __VLS_17;
        const __VLS_18 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.gatewayStore.gateways.length === 0))
                        return;
                    __VLS_ctx.handleToggle(gw.profile, gw.running);
                    // @ts-ignore
                    [handleToggle,];
                } });
        const { default: __VLS_19 } = __VLS_15.slots;
        (gw.running ? __VLS_ctx.t('common.stop') : __VLS_ctx.t('common.start'));
        // @ts-ignore
        [t, t,];
        var __VLS_15;
        var __VLS_16;
        // @ts-ignore
        [];
    }
}
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
