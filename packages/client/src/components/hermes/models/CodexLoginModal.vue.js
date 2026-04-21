/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onUnmounted } from 'vue';
import { NModal, NButton, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { startCodexLogin, pollCodexLogin } from '@/api/hermes/codex-auth';
const { t } = useI18n();
const emit = defineEmits();
const message = useMessage();
const showModal = ref(true);
const status = ref('idle');
const userCode = ref('');
const verificationUrl = ref('');
const sessionId = ref('');
const errorMessage = ref('');
let pollTimer = null;
async function startLogin() {
    status.value = 'loading';
    errorMessage.value = '';
    try {
        const data = await startCodexLogin();
        userCode.value = data.user_code;
        verificationUrl.value = data.verification_url;
        sessionId.value = data.session_id;
        status.value = 'waiting';
        startPolling();
    }
    catch (err) {
        status.value = 'error';
        const msg = err.message || '';
        // Try to extract friendly error from response
        try {
            const match = msg.match(/\{[\s\S]*\}$/);
            if (match) {
                const body = JSON.parse(match[0]);
                errorMessage.value = body.error || msg;
            }
            else {
                errorMessage.value = msg;
            }
        }
        catch {
            errorMessage.value = msg;
        }
        message.error(errorMessage.value);
    }
}
function startPolling() {
    stopPolling();
    pollTimer = setTimeout(async () => {
        try {
            const result = await pollCodexLogin(sessionId.value);
            if (result.status === 'pending') {
                startPolling();
            }
            else if (result.status === 'approved') {
                status.value = 'approved';
                message.success(t('models.codexApproved'));
                setTimeout(() => {
                    showModal.value = false;
                    setTimeout(() => emit('success'), 200);
                }, 1000);
            }
            else if (result.status === 'expired') {
                status.value = 'expired';
            }
            else if (result.status === 'error') {
                status.value = 'error';
                errorMessage.value = result.error || 'Unknown error';
            }
        }
        catch {
            startPolling();
        }
    }, 3000);
}
function stopPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}
function handleClose() {
    stopPolling();
    showModal.value = false;
    setTimeout(() => emit('close'), 200);
}
function copyCode() {
    navigator.clipboard.writeText(userCode.value);
    message.success(t('models.codexCopyCode'));
}
function openLink() {
    window.open(verificationUrl.value, '_blank');
}
function retry() {
    status.value = 'idle';
    userCode.value = '';
    verificationUrl.value = '';
    sessionId.value = '';
    errorMessage.value = '';
    startLogin();
}
onUnmounted(() => {
    stopPolling();
});
// Auto-start when modal opens
startLogin();
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
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NModal | typeof __VLS_components.NModal} */
NModal;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('models.codexLoginTitle')),
    ...{ style: ({ width: 'min(440px, calc(100vw - 32px))' }) },
    maskClosable: (__VLS_ctx.status !== 'waiting'),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.t('models.codexLoginTitle')),
    ...{ style: ({ width: 'min(440px, calc(100vw - 32px))' }) },
    maskClosable: (__VLS_ctx.status !== 'waiting'),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ afterLeave: {} },
    { onAfterLeave: (...[$event]) => {
            __VLS_ctx.emit('close');
            // @ts-ignore
            [showModal, t, status, emit,];
        } });
var __VLS_7 = {};
const { default: __VLS_8 } = __VLS_3.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "codex-login" },
});
/** @type {__VLS_StyleScopedClasses['codex-login']} */ ;
if (__VLS_ctx.status === 'idle' || __VLS_ctx.status === 'loading') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "codex-login__state" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__state']} */ ;
    let __VLS_9;
    /** @ts-ignore @type {typeof __VLS_components.NSpin} */
    NSpin;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
        size: "small",
    }));
    const __VLS_11 = __VLS_10({
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
}
else if (__VLS_ctx.status === 'waiting') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "codex-login__state" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "codex-login__hint" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__hint']} */ ;
    (__VLS_ctx.t('models.codexWaiting'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (__VLS_ctx.copyCode) },
        ...{ class: "codex-login__code" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__code']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "codex-login__code-text" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__code-text']} */ ;
    (__VLS_ctx.userCode);
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "9",
        y: "9",
        width: "13",
        height: "13",
        rx: "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1",
    });
    let __VLS_14;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_15 = __VLS_asFunctionalComponent1(__VLS_14, new __VLS_14({
        ...{ 'onClick': {} },
        type: "primary",
        block: true,
    }));
    const __VLS_16 = __VLS_15({
        ...{ 'onClick': {} },
        type: "primary",
        block: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_15));
    let __VLS_19;
    const __VLS_20 = ({ click: {} },
        { onClick: (__VLS_ctx.openLink) });
    const { default: __VLS_21 } = __VLS_17.slots;
    {
        const { icon: __VLS_22 } = __VLS_17.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
            d: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "15 3 21 3 21 9",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
            x1: "10",
            y1: "14",
            x2: "21",
            y2: "3",
        });
        // @ts-ignore
        [t, status, status, status, copyCode, userCode, openLink,];
    }
    (__VLS_ctx.t('models.codexOpenLink'));
    // @ts-ignore
    [t,];
    var __VLS_17;
    var __VLS_18;
}
else if (__VLS_ctx.status === 'approved') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "codex-login__state codex-login__state--success" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__state']} */ ;
    /** @type {__VLS_StyleScopedClasses['codex-login__state--success']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "40",
        height: "40",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M22 11.08V12a10 10 0 11-5.93-9.14",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "22 4 12 14.01 9 11.01",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.t('models.codexApproved'));
}
else if (__VLS_ctx.status === 'expired') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "codex-login__state" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "codex-login__error" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__error']} */ ;
    (__VLS_ctx.t('models.codexExpired'));
    let __VLS_23;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_25 = __VLS_24({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_24));
    let __VLS_28;
    const __VLS_29 = ({ click: {} },
        { onClick: (__VLS_ctx.retry) });
    const { default: __VLS_30 } = __VLS_26.slots;
    (__VLS_ctx.t('common.retry'));
    // @ts-ignore
    [t, t, t, status, status, retry,];
    var __VLS_26;
    var __VLS_27;
}
else if (__VLS_ctx.status === 'error') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "codex-login__state" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "codex-login__error" },
    });
    /** @type {__VLS_StyleScopedClasses['codex-login__error']} */ ;
    (__VLS_ctx.errorMessage);
    let __VLS_31;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_32 = __VLS_asFunctionalComponent1(__VLS_31, new __VLS_31({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_33 = __VLS_32({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_32));
    let __VLS_36;
    const __VLS_37 = ({ click: {} },
        { onClick: (__VLS_ctx.retry) });
    const { default: __VLS_38 } = __VLS_34.slots;
    (__VLS_ctx.t('common.retry'));
    // @ts-ignore
    [t, status, retry, errorMessage,];
    var __VLS_34;
    var __VLS_35;
}
{
    const { footer: __VLS_39 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_40;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent1(__VLS_40, new __VLS_40({
        ...{ 'onClick': {} },
        disabled: (__VLS_ctx.status === 'waiting'),
    }));
    const __VLS_42 = __VLS_41({
        ...{ 'onClick': {} },
        disabled: (__VLS_ctx.status === 'waiting'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    let __VLS_45;
    const __VLS_46 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_47 } = __VLS_43.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, status, handleClose,];
    var __VLS_43;
    var __VLS_44;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_3;
var __VLS_4;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
