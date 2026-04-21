/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted, computed } from 'vue';
import { NSelect, NButton, NSpin, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { fetchLogFiles, fetchLogs } from '@/api/hermes/logs';
const { t } = useI18n();
const message = useMessage();
const logFiles = ref([]);
const selectedLog = ref('agent');
const entries = ref([]);
const loading = ref(false);
const lineCount = ref(100);
const levelFilter = ref('');
const searchQuery = ref('');
const logOptions = computed(() => logFiles.value.map(f => ({ label: `${f.name} (${f.size})`, value: f.name })));
const levelOptions = computed(() => [
    { label: t('logs.all'), value: '' },
    { label: 'ERROR', value: 'ERROR' },
    { label: 'WARNING', value: 'WARNING' },
    { label: 'INFO', value: 'INFO' },
    { label: 'DEBUG', value: 'DEBUG' },
]);
const lineOptions = [
    { label: '50', value: 50 },
    { label: '100', value: 100 },
    { label: '200', value: 200 },
    { label: '500', value: 500 },
];
const filteredEntries = computed(() => {
    if (!searchQuery.value)
        return entries.value;
    const q = searchQuery.value.toLowerCase();
    return entries.value.filter(e => e.message.toLowerCase().includes(q) ||
        e.logger.toLowerCase().includes(q) ||
        e.raw.toLowerCase().includes(q));
});
function levelClass(level) {
    switch (level) {
        case 'ERROR': return 'level-error';
        case 'WARNING': return 'level-warning';
        case 'DEBUG': return 'level-debug';
        default: return 'level-info';
    }
}
function formatTime(ts) {
    const match = ts.match(/\d{2}:\d{2}:\d{2}/);
    return match ? match[0] : ts;
}
function parseAccessLog(msg) {
    const match = msg.match(/"(\w+)\s+(\S+)\s+HTTP\/[^"]+"\s+(\d+)/);
    if (match)
        return { method: match[1], path: match[2], status: match[3] };
    return null;
}
async function loadLogs() {
    loading.value = true;
    try {
        const data = await fetchLogs(selectedLog.value, {
            lines: lineCount.value,
            level: levelFilter.value || undefined,
        });
        entries.value = data.filter((e) => e !== null);
    }
    catch (e) {
        message.error(e.message);
    }
    finally {
        loading.value = false;
    }
}
onMounted(async () => {
    logFiles.value = await fetchLogFiles();
    await loadLogs();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['log-message']} */ ;
/** @type {__VLS_StyleScopedClasses['level-error']} */ ;
/** @type {__VLS_StyleScopedClasses['level-warning']} */ ;
/** @type {__VLS_StyleScopedClasses['log-message']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "logs-view" },
});
/** @type {__VLS_StyleScopedClasses['logs-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('logs.title'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-actions" },
});
/** @type {__VLS_StyleScopedClasses['header-actions']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.selectedLog),
    options: (__VLS_ctx.logOptions),
    size: "small",
    ...{ class: "input-md" },
}));
const __VLS_2 = __VLS_1({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.selectedLog),
    options: (__VLS_ctx.logOptions),
    size: "small",
    ...{ class: "input-md" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ 'update:value': {} },
    { 'onUpdate:value': (__VLS_ctx.loadLogs) });
/** @type {__VLS_StyleScopedClasses['input-md']} */ ;
var __VLS_3;
var __VLS_4;
let __VLS_7;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.levelFilter),
    options: (__VLS_ctx.levelOptions),
    size: "small",
    ...{ class: "input-sm" },
}));
const __VLS_9 = __VLS_8({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.levelFilter),
    options: (__VLS_ctx.levelOptions),
    size: "small",
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_8));
let __VLS_12;
const __VLS_13 = ({ 'update:value': {} },
    { 'onUpdate:value': ((v) => { __VLS_ctx.levelFilter = v; __VLS_ctx.loadLogs(); }) });
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_10;
var __VLS_11;
let __VLS_14;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_15 = __VLS_asFunctionalComponent1(__VLS_14, new __VLS_14({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.lineCount),
    options: (__VLS_ctx.lineOptions),
    size: "small",
    ...{ class: "input-sm" },
}));
const __VLS_16 = __VLS_15({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.lineCount),
    options: (__VLS_ctx.lineOptions),
    size: "small",
    ...{ class: "input-sm" },
}, ...__VLS_functionalComponentArgsRest(__VLS_15));
let __VLS_19;
const __VLS_20 = ({ 'update:value': {} },
    { 'onUpdate:value': ((v) => { __VLS_ctx.lineCount = v; __VLS_ctx.loadLogs(); }) });
/** @type {__VLS_StyleScopedClasses['input-sm']} */ ;
var __VLS_17;
var __VLS_18;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ class: "search-input" },
    placeholder: (__VLS_ctx.t('logs.searchPlaceholder')),
});
(__VLS_ctx.searchQuery);
/** @type {__VLS_StyleScopedClasses['search-input']} */ ;
let __VLS_21;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_22 = __VLS_asFunctionalComponent1(__VLS_21, new __VLS_21({
    ...{ 'onClick': {} },
    size: "small",
    loading: (__VLS_ctx.loading),
}));
const __VLS_23 = __VLS_22({
    ...{ 'onClick': {} },
    size: "small",
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_22));
let __VLS_26;
const __VLS_27 = ({ click: {} },
    { onClick: (__VLS_ctx.loadLogs) });
const { default: __VLS_28 } = __VLS_24.slots;
(__VLS_ctx.t('logs.refresh'));
// @ts-ignore
[t, t, t, selectedLog, logOptions, loadLogs, loadLogs, loadLogs, loadLogs, levelFilter, levelFilter, levelOptions, lineCount, lineCount, lineOptions, searchQuery, loading,];
var __VLS_24;
var __VLS_25;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "logs-body" },
});
/** @type {__VLS_StyleScopedClasses['logs-body']} */ ;
let __VLS_29;
/** @ts-ignore @type {typeof __VLS_components.NSpin | typeof __VLS_components.NSpin} */
NSpin;
// @ts-ignore
const __VLS_30 = __VLS_asFunctionalComponent1(__VLS_29, new __VLS_29({
    show: (__VLS_ctx.loading),
}));
const __VLS_31 = __VLS_30({
    show: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_30));
const { default: __VLS_34 } = __VLS_32.slots;
if (__VLS_ctx.filteredEntries.length === 0 && !__VLS_ctx.loading) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "logs-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['logs-empty']} */ ;
    (__VLS_ctx.t('logs.noEntries'));
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "log-list" },
});
/** @type {__VLS_StyleScopedClasses['log-list']} */ ;
for (const [entry, idx] of __VLS_vFor((__VLS_ctx.filteredEntries))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (idx),
        ...{ class: "log-entry" },
        ...{ class: (__VLS_ctx.levelClass(entry.level)) },
    });
    /** @type {__VLS_StyleScopedClasses['log-entry']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "log-time" },
    });
    /** @type {__VLS_StyleScopedClasses['log-time']} */ ;
    (__VLS_ctx.formatTime(entry.timestamp));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "log-level" },
        ...{ class: (__VLS_ctx.levelClass(entry.level)) },
    });
    /** @type {__VLS_StyleScopedClasses['log-level']} */ ;
    (entry.level);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "log-logger" },
    });
    /** @type {__VLS_StyleScopedClasses['log-logger']} */ ;
    (entry.logger);
    if (__VLS_ctx.parseAccessLog(entry.message)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "access-method" },
        });
        /** @type {__VLS_StyleScopedClasses['access-method']} */ ;
        (__VLS_ctx.parseAccessLog(entry.message).method);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "access-path" },
        });
        /** @type {__VLS_StyleScopedClasses['access-path']} */ ;
        (__VLS_ctx.parseAccessLog(entry.message).path);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "access-status" },
            ...{ class: ('status-' + (__VLS_ctx.parseAccessLog(entry.message).status?.[0] || 'x')) },
        });
        /** @type {__VLS_StyleScopedClasses['access-status']} */ ;
        (__VLS_ctx.parseAccessLog(entry.message).status);
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "log-message" },
        });
        /** @type {__VLS_StyleScopedClasses['log-message']} */ ;
        (entry.message);
    }
    // @ts-ignore
    [t, loading, loading, filteredEntries, filteredEntries, levelClass, levelClass, formatTime, parseAccessLog, parseAccessLog, parseAccessLog, parseAccessLog, parseAccessLog,];
}
// @ts-ignore
[];
var __VLS_32;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
