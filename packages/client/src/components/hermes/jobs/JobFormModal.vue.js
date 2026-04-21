/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted, computed } from 'vue';
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NInputNumber, useMessage } from 'naive-ui';
import { useJobsStore } from '@/stores/hermes/jobs';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const props = defineProps();
const emit = defineEmits();
const jobsStore = useJobsStore();
const message = useMessage();
const showModal = ref(true);
const loading = ref(false);
const formData = ref({
    name: '',
    schedule: '',
    prompt: '',
    deliver: 'origin',
    repeat_times: null,
});
const presetValue = ref(null);
const isEdit = computed(() => !!props.jobId);
const schedulePresets = computed(() => [
    { label: t('jobs.presetEveryMinute'), value: '* * * * *' },
    { label: t('jobs.presetEvery5Min'), value: '*/5 * * * *' },
    { label: t('jobs.presetEveryHour'), value: '0 * * * *' },
    { label: t('jobs.presetEveryDay'), value: '0 0 * * *' },
    { label: t('jobs.presetEveryDay9'), value: '0 9 * * *' },
    { label: t('jobs.presetEveryMonday'), value: '0 9 * * 1' },
    { label: t('jobs.presetEveryMonth'), value: '0 9 1 * *' },
]);
const targetOptions = computed(() => [
    { label: t('jobs.origin'), value: 'origin' },
    { label: t('jobs.local'), value: 'local' },
]);
const originalSchedule = ref(null);
onMounted(async () => {
    if (props.jobId) {
        try {
            const { getJob } = await import('@/api/hermes/jobs');
            const job = await getJob(props.jobId);
            formData.value = {
                name: job.name,
                schedule: typeof job.schedule === 'string' ? job.schedule : (job.schedule?.expr || job.schedule_display || ''),
                prompt: job.prompt,
                deliver: job.deliver || 'origin',
                repeat_times: typeof job.repeat === 'number' ? job.repeat : (typeof job.repeat === 'object' ? job.repeat.times : null),
            };
            if (typeof job.schedule === 'object' && job.schedule) {
                originalSchedule.value = job.schedule;
            }
        }
        catch (e) {
            message.error(t('jobs.loadFailed') + ': ' + e.message);
        }
    }
});
async function handleSave() {
    if (!formData.value.name.trim()) {
        message.warning(t('jobs.nameRequired'));
        return;
    }
    if (!formData.value.schedule.trim()) {
        message.warning(t('jobs.scheduleRequired'));
        return;
    }
    loading.value = true;
    try {
        const payload = {
            name: formData.value.name,
            schedule: formData.value.schedule,
            prompt: formData.value.prompt,
            deliver: formData.value.deliver,
            repeat: formData.value.repeat_times ?? undefined,
        };
        if (isEdit.value && originalSchedule.value) {
            payload.schedule = {
                kind: originalSchedule.value.kind,
                expr: formData.value.schedule,
                display: formData.value.schedule,
            };
        }
        if (isEdit.value) {
            await jobsStore.updateJob(props.jobId, payload);
            message.success(t('jobs.jobUpdated'));
        }
        else {
            await jobsStore.createJob(payload);
            message.success(t('jobs.jobCreated'));
        }
        emit('saved');
    }
    catch (e) {
        message.error(e.message);
    }
    finally {
        loading.value = false;
    }
}
function handleClose() {
    showModal.value = false;
    setTimeout(() => emit('close'), 200);
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
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NModal | typeof __VLS_components.NModal} */
NModal;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.isEdit ? __VLS_ctx.t('jobs.editJob') : __VLS_ctx.t('jobs.createJob')),
    ...{ style: ({ width: 'min(520px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}));
const __VLS_2 = __VLS_1({
    ...{ 'onAfterLeave': {} },
    show: (__VLS_ctx.showModal),
    preset: "card",
    title: (__VLS_ctx.isEdit ? __VLS_ctx.t('jobs.editJob') : __VLS_ctx.t('jobs.createJob')),
    ...{ style: ({ width: 'min(520px, calc(100vw - 32px))' }) },
    maskClosable: (!__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ afterLeave: {} },
    { onAfterLeave: (...[$event]) => {
            __VLS_ctx.emit('close');
            // @ts-ignore
            [showModal, isEdit, t, t, loading, emit,];
        } });
var __VLS_7 = {};
const { default: __VLS_8 } = __VLS_3.slots;
let __VLS_9;
/** @ts-ignore @type {typeof __VLS_components.NForm | typeof __VLS_components.NForm} */
NForm;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    labelPlacement: "top",
}));
const __VLS_11 = __VLS_10({
    labelPlacement: "top",
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
const { default: __VLS_14 } = __VLS_12.slots;
let __VLS_15;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({
    label: (__VLS_ctx.t('jobs.name')),
    required: true,
}));
const __VLS_17 = __VLS_16({
    label: (__VLS_ctx.t('jobs.name')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_16));
const { default: __VLS_20 } = __VLS_18.slots;
let __VLS_21;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_22 = __VLS_asFunctionalComponent1(__VLS_21, new __VLS_21({
    value: (__VLS_ctx.formData.name),
    placeholder: (__VLS_ctx.t('jobs.namePlaceholder')),
    maxlength: "200",
    showCount: true,
}));
const __VLS_23 = __VLS_22({
    value: (__VLS_ctx.formData.name),
    placeholder: (__VLS_ctx.t('jobs.namePlaceholder')),
    maxlength: "200",
    showCount: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_22));
// @ts-ignore
[t, t, formData,];
var __VLS_18;
let __VLS_26;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_27 = __VLS_asFunctionalComponent1(__VLS_26, new __VLS_26({
    label: (__VLS_ctx.t('jobs.schedule')),
    required: true,
}));
const __VLS_28 = __VLS_27({
    label: (__VLS_ctx.t('jobs.schedule')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_27));
const { default: __VLS_31 } = __VLS_29.slots;
let __VLS_32;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({
    value: (__VLS_ctx.formData.schedule),
    placeholder: (__VLS_ctx.t('jobs.schedulePlaceholder')),
}));
const __VLS_34 = __VLS_33({
    value: (__VLS_ctx.formData.schedule),
    placeholder: (__VLS_ctx.t('jobs.schedulePlaceholder')),
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
// @ts-ignore
[t, t, formData,];
var __VLS_29;
let __VLS_37;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_38 = __VLS_asFunctionalComponent1(__VLS_37, new __VLS_37({
    label: (__VLS_ctx.t('jobs.quickPresets')),
}));
const __VLS_39 = __VLS_38({
    label: (__VLS_ctx.t('jobs.quickPresets')),
}, ...__VLS_functionalComponentArgsRest(__VLS_38));
const { default: __VLS_42 } = __VLS_40.slots;
let __VLS_43;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.presetValue),
    options: (__VLS_ctx.schedulePresets),
    placeholder: (__VLS_ctx.t('jobs.selectPreset')),
}));
const __VLS_45 = __VLS_44({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.presetValue),
    options: (__VLS_ctx.schedulePresets),
    placeholder: (__VLS_ctx.t('jobs.selectPreset')),
}, ...__VLS_functionalComponentArgsRest(__VLS_44));
let __VLS_48;
const __VLS_49 = ({ 'update:value': {} },
    { 'onUpdate:value': (v => __VLS_ctx.formData.schedule = v) });
var __VLS_46;
var __VLS_47;
// @ts-ignore
[t, t, formData, presetValue, schedulePresets,];
var __VLS_40;
let __VLS_50;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_51 = __VLS_asFunctionalComponent1(__VLS_50, new __VLS_50({
    label: (__VLS_ctx.t('jobs.prompt')),
    required: true,
}));
const __VLS_52 = __VLS_51({
    label: (__VLS_ctx.t('jobs.prompt')),
    required: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_51));
const { default: __VLS_55 } = __VLS_53.slots;
let __VLS_56;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_57 = __VLS_asFunctionalComponent1(__VLS_56, new __VLS_56({
    value: (__VLS_ctx.formData.prompt),
    type: "textarea",
    placeholder: (__VLS_ctx.t('jobs.promptPlaceholder')),
    rows: (4),
    maxlength: "5000",
    showCount: true,
}));
const __VLS_58 = __VLS_57({
    value: (__VLS_ctx.formData.prompt),
    type: "textarea",
    placeholder: (__VLS_ctx.t('jobs.promptPlaceholder')),
    rows: (4),
    maxlength: "5000",
    showCount: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_57));
// @ts-ignore
[t, t, formData,];
var __VLS_53;
let __VLS_61;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_62 = __VLS_asFunctionalComponent1(__VLS_61, new __VLS_61({
    label: (__VLS_ctx.t('jobs.deliverTarget')),
}));
const __VLS_63 = __VLS_62({
    label: (__VLS_ctx.t('jobs.deliverTarget')),
}, ...__VLS_functionalComponentArgsRest(__VLS_62));
const { default: __VLS_66 } = __VLS_64.slots;
let __VLS_67;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_68 = __VLS_asFunctionalComponent1(__VLS_67, new __VLS_67({
    value: (__VLS_ctx.formData.deliver),
    options: (__VLS_ctx.targetOptions),
}));
const __VLS_69 = __VLS_68({
    value: (__VLS_ctx.formData.deliver),
    options: (__VLS_ctx.targetOptions),
}, ...__VLS_functionalComponentArgsRest(__VLS_68));
// @ts-ignore
[t, formData, targetOptions,];
var __VLS_64;
let __VLS_72;
/** @ts-ignore @type {typeof __VLS_components.NFormItem | typeof __VLS_components.NFormItem} */
NFormItem;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent1(__VLS_72, new __VLS_72({
    label: (__VLS_ctx.t('jobs.repeatCount')),
}));
const __VLS_74 = __VLS_73({
    label: (__VLS_ctx.t('jobs.repeatCount')),
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
const { default: __VLS_77 } = __VLS_75.slots;
let __VLS_78;
/** @ts-ignore @type {typeof __VLS_components.NInputNumber} */
NInputNumber;
// @ts-ignore
const __VLS_79 = __VLS_asFunctionalComponent1(__VLS_78, new __VLS_78({
    value: (__VLS_ctx.formData.repeat_times),
    min: (1),
    placeholder: (__VLS_ctx.t('jobs.repeatPlaceholder')),
    clearable: true,
    ...{ style: {} },
}));
const __VLS_80 = __VLS_79({
    value: (__VLS_ctx.formData.repeat_times),
    min: (1),
    placeholder: (__VLS_ctx.t('jobs.repeatPlaceholder')),
    clearable: true,
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_79));
// @ts-ignore
[t, t, formData,];
var __VLS_75;
// @ts-ignore
[];
var __VLS_12;
{
    const { footer: __VLS_83 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    let __VLS_84;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_85 = __VLS_asFunctionalComponent1(__VLS_84, new __VLS_84({
        ...{ 'onClick': {} },
    }));
    const __VLS_86 = __VLS_85({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_85));
    let __VLS_89;
    const __VLS_90 = ({ click: {} },
        { onClick: (__VLS_ctx.handleClose) });
    const { default: __VLS_91 } = __VLS_87.slots;
    (__VLS_ctx.t('common.cancel'));
    // @ts-ignore
    [t, handleClose,];
    var __VLS_87;
    var __VLS_88;
    let __VLS_92;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_93 = __VLS_asFunctionalComponent1(__VLS_92, new __VLS_92({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }));
    const __VLS_94 = __VLS_93({
        ...{ 'onClick': {} },
        type: "primary",
        loading: (__VLS_ctx.loading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_93));
    let __VLS_97;
    const __VLS_98 = ({ click: {} },
        { onClick: (__VLS_ctx.handleSave) });
    const { default: __VLS_99 } = __VLS_95.slots;
    (__VLS_ctx.isEdit ? __VLS_ctx.t('common.update') : __VLS_ctx.t('common.create'));
    // @ts-ignore
    [isEdit, t, t, loading, handleSave,];
    var __VLS_95;
    var __VLS_96;
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
    __typeProps: {},
});
export default {};
