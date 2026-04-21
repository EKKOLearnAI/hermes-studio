/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { computed } from 'vue';
import { NButton, NTooltip, useMessage } from 'naive-ui';
import { useJobsStore } from '@/stores/hermes/jobs';
import { useI18n } from 'vue-i18n';
const props = defineProps();
const emit = defineEmits();
const { t } = useI18n();
const jobsStore = useJobsStore();
const message = useMessage();
const jobId = computed(() => props.job.job_id || props.job.id);
const statusLabel = computed(() => {
    if (props.job.state === 'running')
        return t('jobs.status.running');
    if (props.job.state === 'paused')
        return t('jobs.status.paused');
    if (!props.job.enabled)
        return t('jobs.status.disabled');
    return t('jobs.status.scheduled');
});
const statusType = computed(() => {
    if (props.job.state === 'running')
        return 'info';
    if (props.job.state === 'paused')
        return 'warning';
    if (!props.job.enabled)
        return 'error';
    return 'success';
});
const scheduleExpr = computed(() => {
    const s = props.job.schedule;
    if (typeof s === 'string')
        return s;
    return s?.expr || props.job.schedule_display || '—';
});
const formatTime = (t) => {
    if (!t)
        return '—';
    return new Date(t).toLocaleString();
};
async function handlePause() {
    try {
        await jobsStore.pauseJob(jobId.value);
        message.success(t('jobs.jobPaused'));
    }
    catch (e) {
        message.error(e.message);
    }
}
async function handleResume() {
    try {
        await jobsStore.resumeJob(jobId.value);
        message.success(t('jobs.jobResumed'));
    }
    catch (e) {
        message.error(e.message);
    }
}
async function handleRun() {
    try {
        await jobsStore.runJob(jobId.value);
        message.info(t('jobs.jobTriggered'));
    }
    catch (e) {
        message.error(e.message);
    }
}
async function handleDelete() {
    try {
        await jobsStore.deleteJob(jobId.value);
        message.success(t('jobs.jobDeleted'));
    }
    catch (e) {
        message.error(e.message);
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
    ...{ class: "job-card" },
});
/** @type {__VLS_StyleScopedClasses['job-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-header" },
});
/** @type {__VLS_StyleScopedClasses['card-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "job-name" },
});
/** @type {__VLS_StyleScopedClasses['job-name']} */ ;
(__VLS_ctx.job.name);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-badge" },
    ...{ class: (__VLS_ctx.statusType) },
});
/** @type {__VLS_StyleScopedClasses['status-badge']} */ ;
(__VLS_ctx.statusLabel);
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
(__VLS_ctx.t('jobs.info.schedule'));
__VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
    ...{ class: "info-value mono" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.scheduleExpr);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('jobs.info.lastRun'));
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-value" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
(__VLS_ctx.formatTime(__VLS_ctx.job.last_run_at));
if (__VLS_ctx.job.last_status) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "run-status" },
        ...{ class: ({ ok: __VLS_ctx.job.last_status === 'ok', err: __VLS_ctx.job.last_status !== 'ok' }) },
    });
    /** @type {__VLS_StyleScopedClasses['run-status']} */ ;
    /** @type {__VLS_StyleScopedClasses['ok']} */ ;
    /** @type {__VLS_StyleScopedClasses['err']} */ ;
    (__VLS_ctx.job.last_status === 'ok' ? __VLS_ctx.t('common.ok') : __VLS_ctx.job.last_status);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('jobs.info.nextRun'));
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-value" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
(__VLS_ctx.formatTime(__VLS_ctx.job.next_run_at));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "info-row" },
});
/** @type {__VLS_StyleScopedClasses['info-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-label" },
});
/** @type {__VLS_StyleScopedClasses['info-label']} */ ;
(__VLS_ctx.t('jobs.info.deliver'));
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "info-value" },
});
/** @type {__VLS_StyleScopedClasses['info-value']} */ ;
(__VLS_ctx.job.deliver);
if (__VLS_ctx.job.origin) {
    (__VLS_ctx.job.origin.platform);
}
if (__VLS_ctx.job.repeat) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "info-row" },
    });
    /** @type {__VLS_StyleScopedClasses['info-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "info-label" },
    });
    /** @type {__VLS_StyleScopedClasses['info-label']} */ ;
    (__VLS_ctx.t('jobs.info.repeat'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "info-value" },
    });
    /** @type {__VLS_StyleScopedClasses['info-value']} */ ;
    if (typeof __VLS_ctx.job.repeat === 'string') {
        (__VLS_ctx.job.repeat);
    }
    else {
        (__VLS_ctx.job.repeat.completed);
        (__VLS_ctx.job.repeat.times ?? '∞');
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "card-actions" },
});
/** @type {__VLS_StyleScopedClasses['card-actions']} */ ;
if (__VLS_ctx.job.state !== 'paused' && __VLS_ctx.job.enabled) {
    let __VLS_0;
    /** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
    NTooltip;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
    const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    const { default: __VLS_5 } = __VLS_3.slots;
    {
        const { trigger: __VLS_6 } = __VLS_3.slots;
        let __VLS_7;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }));
        const __VLS_9 = __VLS_8({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_8));
        let __VLS_12;
        const __VLS_13 = ({ click: {} },
            { onClick: (__VLS_ctx.handlePause) });
        const { default: __VLS_14 } = __VLS_10.slots;
        (__VLS_ctx.t('jobs.action.pause'));
        // @ts-ignore
        [job, job, job, job, job, job, job, job, job, job, job, job, job, job, job, job, job, job, statusType, statusLabel, t, t, t, t, t, t, t, scheduleExpr, formatTime, formatTime, handlePause,];
        var __VLS_10;
        var __VLS_11;
        // @ts-ignore
        [];
    }
    (__VLS_ctx.t('jobs.action.pauseJob'));
    // @ts-ignore
    [t,];
    var __VLS_3;
}
else if (__VLS_ctx.job.state === 'paused') {
    let __VLS_15;
    /** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
    NTooltip;
    // @ts-ignore
    const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({}));
    const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
    const { default: __VLS_20 } = __VLS_18.slots;
    {
        const { trigger: __VLS_21 } = __VLS_18.slots;
        let __VLS_22;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_23 = __VLS_asFunctionalComponent1(__VLS_22, new __VLS_22({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }));
        const __VLS_24 = __VLS_23({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_23));
        let __VLS_27;
        const __VLS_28 = ({ click: {} },
            { onClick: (__VLS_ctx.handleResume) });
        const { default: __VLS_29 } = __VLS_25.slots;
        (__VLS_ctx.t('jobs.action.resume'));
        // @ts-ignore
        [job, t, handleResume,];
        var __VLS_25;
        var __VLS_26;
        // @ts-ignore
        [];
    }
    (__VLS_ctx.t('jobs.action.resumeJob'));
    // @ts-ignore
    [t,];
    var __VLS_18;
}
let __VLS_30;
/** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
NTooltip;
// @ts-ignore
const __VLS_31 = __VLS_asFunctionalComponent1(__VLS_30, new __VLS_30({}));
const __VLS_32 = __VLS_31({}, ...__VLS_functionalComponentArgsRest(__VLS_31));
const { default: __VLS_35 } = __VLS_33.slots;
{
    const { trigger: __VLS_36 } = __VLS_33.slots;
    let __VLS_37;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_38 = __VLS_asFunctionalComponent1(__VLS_37, new __VLS_37({
        ...{ 'onClick': {} },
        size: "tiny",
        quaternary: true,
    }));
    const __VLS_39 = __VLS_38({
        ...{ 'onClick': {} },
        size: "tiny",
        quaternary: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_38));
    let __VLS_42;
    const __VLS_43 = ({ click: {} },
        { onClick: (__VLS_ctx.handleRun) });
    const { default: __VLS_44 } = __VLS_40.slots;
    (__VLS_ctx.t('jobs.action.runNow'));
    // @ts-ignore
    [t, handleRun,];
    var __VLS_40;
    var __VLS_41;
    // @ts-ignore
    [];
}
(__VLS_ctx.t('jobs.action.triggerImmediately'));
// @ts-ignore
[t,];
var __VLS_33;
let __VLS_45;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_46 = __VLS_asFunctionalComponent1(__VLS_45, new __VLS_45({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
}));
const __VLS_47 = __VLS_46({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_46));
let __VLS_50;
const __VLS_51 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.emit('edit', __VLS_ctx.jobId);
            // @ts-ignore
            [emit, jobId,];
        } });
const { default: __VLS_52 } = __VLS_48.slots;
(__VLS_ctx.t('common.edit'));
// @ts-ignore
[t,];
var __VLS_48;
var __VLS_49;
let __VLS_53;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_54 = __VLS_asFunctionalComponent1(__VLS_53, new __VLS_53({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
}));
const __VLS_55 = __VLS_54({
    ...{ 'onClick': {} },
    size: "tiny",
    quaternary: true,
    type: "error",
}, ...__VLS_functionalComponentArgsRest(__VLS_54));
let __VLS_58;
const __VLS_59 = ({ click: {} },
    { onClick: (__VLS_ctx.handleDelete) });
const { default: __VLS_60 } = __VLS_56.slots;
(__VLS_ctx.t('common.delete'));
// @ts-ignore
[t, handleDelete,];
var __VLS_56;
var __VLS_57;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
