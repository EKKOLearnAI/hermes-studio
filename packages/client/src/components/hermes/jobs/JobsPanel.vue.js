/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import JobCard from './JobCard.vue';
import { useJobsStore } from '@/stores/hermes/jobs';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const emit = defineEmits();
const jobsStore = useJobsStore();
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
if (__VLS_ctx.jobsStore.jobs.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-state" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "48",
        height: "48",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1",
        ...{ class: "empty-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "3",
        y: "4",
        width: "18",
        height: "18",
        rx: "2",
        ry: "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "16",
        y1: "2",
        x2: "16",
        y2: "6",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "8",
        y1: "2",
        x2: "8",
        y2: "6",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "3",
        y1: "10",
        x2: "21",
        y2: "10",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.t('jobs.noJobs'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "jobs-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['jobs-grid']} */ ;
    for (const [job] of __VLS_vFor((__VLS_ctx.jobsStore.jobs))) {
        const __VLS_0 = JobCard;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            ...{ 'onEdit': {} },
            key: (job.id),
            job: (job),
        }));
        const __VLS_2 = __VLS_1({
            ...{ 'onEdit': {} },
            key: (job.id),
            job: (job),
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
        let __VLS_5;
        const __VLS_6 = ({ edit: {} },
            { onEdit: (...[$event]) => {
                    if (!!(__VLS_ctx.jobsStore.jobs.length === 0))
                        return;
                    __VLS_ctx.emit('edit', job.id);
                    // @ts-ignore
                    [jobsStore, jobsStore, t, emit,];
                } });
        var __VLS_3;
        var __VLS_4;
        // @ts-ignore
        [];
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
