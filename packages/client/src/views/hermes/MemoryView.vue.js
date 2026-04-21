/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted, computed } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue';
import { fetchMemory, saveMemory } from '@/api/hermes/skills';
const { t } = useI18n();
const message = useMessage();
const loading = ref(false);
const data = ref(null);
const editingSection = ref(null);
const editContent = ref('');
const saving = ref(false);
onMounted(loadMemory);
async function loadMemory() {
    loading.value = true;
    try {
        data.value = await fetchMemory();
    }
    catch (err) {
        console.error('Failed to load memory:', err);
        message.error(t('memory.loadFailed'));
    }
    finally {
        loading.value = false;
    }
}
function startEdit(section) {
    editingSection.value = section;
    editContent.value = data.value?.[section] || '';
}
function cancelEdit() {
    editingSection.value = null;
    editContent.value = '';
}
async function handleSave() {
    if (!editingSection.value)
        return;
    saving.value = true;
    try {
        await saveMemory(editingSection.value, editContent.value);
        await loadMemory();
        editingSection.value = null;
        editContent.value = '';
        message.success(t('common.saved'));
    }
    catch (err) {
        message.error(`${t('common.saveFailed')}: ${err.message}`);
    }
    finally {
        saving.value = false;
    }
}
function formatTime(ts) {
    if (!ts)
        return '';
    return new Date(ts).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}
const memoryEmpty = computed(() => !data.value?.memory?.trim());
const userEmpty = computed(() => !data.value?.user?.trim());
const soulEmpty = computed(() => !data.value?.soul?.trim());
const displayMemory = computed(() => (data.value?.memory || '').replace(/§/g, '\n\n'));
const displayUser = computed(() => (data.value?.user || '').replace(/§/g, '\n\n'));
const displaySoul = computed(() => (data.value?.soul || '').replace(/§/g, '\n\n'));
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "memory-view" },
});
/** @type {__VLS_StyleScopedClasses['memory-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('memory.title'));
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    size: "small",
    quaternary: true,
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    size: "small",
    quaternary: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (__VLS_ctx.loadMemory) });
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
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "23 4 23 10 17 10",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10",
    });
    // @ts-ignore
    [t, loadMemory,];
}
(__VLS_ctx.t('memory.refresh'));
// @ts-ignore
[t,];
var __VLS_3;
var __VLS_4;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "memory-content" },
});
/** @type {__VLS_StyleScopedClasses['memory-content']} */ ;
if (__VLS_ctx.loading && !__VLS_ctx.data) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "memory-loading" },
    });
    /** @type {__VLS_StyleScopedClasses['memory-loading']} */ ;
    (__VLS_ctx.t('common.loading'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "memory-sections" },
    });
    /** @type {__VLS_StyleScopedClasses['memory-sections']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "memory-section" },
    });
    /** @type {__VLS_StyleScopedClasses['memory-section']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-header" },
    });
    /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-title-row" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "14 2 14 8 20 8",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "16",
        y1: "13",
        x2: "8",
        y2: "13",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "16",
        y1: "17",
        x2: "8",
        y2: "17",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-title" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
    (__VLS_ctx.t('memory.myNotes'));
    if (__VLS_ctx.data?.memory_mtime) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "section-mtime" },
        });
        /** @type {__VLS_StyleScopedClasses['section-mtime']} */ ;
        (__VLS_ctx.formatTime(__VLS_ctx.data.memory_mtime));
    }
    if (__VLS_ctx.editingSection !== 'memory') {
        let __VLS_9;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }));
        const __VLS_11 = __VLS_10({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_10));
        let __VLS_14;
        const __VLS_15 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading && !__VLS_ctx.data))
                        return;
                    if (!(__VLS_ctx.editingSection !== 'memory'))
                        return;
                    __VLS_ctx.startEdit('memory');
                    // @ts-ignore
                    [t, t, loading, data, data, data, formatTime, editingSection, startEdit,];
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
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
            });
            // @ts-ignore
            [];
        }
        (__VLS_ctx.t('common.edit'));
        // @ts-ignore
        [t,];
        var __VLS_12;
        var __VLS_13;
    }
    if (__VLS_ctx.editingSection !== 'memory') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-body" },
        });
        /** @type {__VLS_StyleScopedClasses['section-body']} */ ;
        if (!__VLS_ctx.memoryEmpty) {
            const __VLS_18 = MarkdownRenderer;
            // @ts-ignore
            const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
                content: (__VLS_ctx.displayMemory),
            }));
            const __VLS_20 = __VLS_19({
                content: (__VLS_ctx.displayMemory),
            }, ...__VLS_functionalComponentArgsRest(__VLS_19));
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "empty-text" },
            });
            /** @type {__VLS_StyleScopedClasses['empty-text']} */ ;
            (__VLS_ctx.t('memory.noNotes'));
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-edit" },
        });
        /** @type {__VLS_StyleScopedClasses['section-edit']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            value: (__VLS_ctx.editContent),
            ...{ class: "edit-textarea" },
            placeholder: (__VLS_ctx.t('memory.notesPlaceholder')),
            spellcheck: "false",
        });
        /** @type {__VLS_StyleScopedClasses['edit-textarea']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "edit-actions" },
        });
        /** @type {__VLS_StyleScopedClasses['edit-actions']} */ ;
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
            { onClick: (__VLS_ctx.cancelEdit) });
        const { default: __VLS_30 } = __VLS_26.slots;
        (__VLS_ctx.t('common.cancel'));
        // @ts-ignore
        [t, t, t, editingSection, memoryEmpty, displayMemory, editContent, cancelEdit,];
        var __VLS_26;
        var __VLS_27;
        let __VLS_31;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_32 = __VLS_asFunctionalComponent1(__VLS_31, new __VLS_31({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }));
        const __VLS_33 = __VLS_32({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }, ...__VLS_functionalComponentArgsRest(__VLS_32));
        let __VLS_36;
        const __VLS_37 = ({ click: {} },
            { onClick: (__VLS_ctx.handleSave) });
        const { default: __VLS_38 } = __VLS_34.slots;
        (__VLS_ctx.t('common.save'));
        // @ts-ignore
        [t, saving, handleSave,];
        var __VLS_34;
        var __VLS_35;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "memory-section" },
    });
    /** @type {__VLS_StyleScopedClasses['memory-section']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-header" },
    });
    /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-title-row" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
        cx: "12",
        cy: "7",
        r: "4",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-title" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
    (__VLS_ctx.t('memory.userProfile'));
    if (__VLS_ctx.data?.user_mtime) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "section-mtime" },
        });
        /** @type {__VLS_StyleScopedClasses['section-mtime']} */ ;
        (__VLS_ctx.formatTime(__VLS_ctx.data.user_mtime));
    }
    if (__VLS_ctx.editingSection !== 'user') {
        let __VLS_39;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_40 = __VLS_asFunctionalComponent1(__VLS_39, new __VLS_39({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }));
        const __VLS_41 = __VLS_40({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_40));
        let __VLS_44;
        const __VLS_45 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading && !__VLS_ctx.data))
                        return;
                    if (!(__VLS_ctx.editingSection !== 'user'))
                        return;
                    __VLS_ctx.startEdit('user');
                    // @ts-ignore
                    [t, data, data, formatTime, editingSection, startEdit,];
                } });
        const { default: __VLS_46 } = __VLS_42.slots;
        {
            const { icon: __VLS_47 } = __VLS_42.slots;
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
            });
            // @ts-ignore
            [];
        }
        (__VLS_ctx.t('common.edit'));
        // @ts-ignore
        [t,];
        var __VLS_42;
        var __VLS_43;
    }
    if (__VLS_ctx.editingSection !== 'user') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-body" },
        });
        /** @type {__VLS_StyleScopedClasses['section-body']} */ ;
        if (!__VLS_ctx.userEmpty) {
            const __VLS_48 = MarkdownRenderer;
            // @ts-ignore
            const __VLS_49 = __VLS_asFunctionalComponent1(__VLS_48, new __VLS_48({
                content: (__VLS_ctx.displayUser),
            }));
            const __VLS_50 = __VLS_49({
                content: (__VLS_ctx.displayUser),
            }, ...__VLS_functionalComponentArgsRest(__VLS_49));
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "empty-text" },
            });
            /** @type {__VLS_StyleScopedClasses['empty-text']} */ ;
            (__VLS_ctx.t('memory.noProfile'));
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-edit" },
        });
        /** @type {__VLS_StyleScopedClasses['section-edit']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            value: (__VLS_ctx.editContent),
            ...{ class: "edit-textarea" },
            placeholder: (__VLS_ctx.t('memory.profilePlaceholder')),
            spellcheck: "false",
        });
        /** @type {__VLS_StyleScopedClasses['edit-textarea']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "edit-actions" },
        });
        /** @type {__VLS_StyleScopedClasses['edit-actions']} */ ;
        let __VLS_53;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_54 = __VLS_asFunctionalComponent1(__VLS_53, new __VLS_53({
            ...{ 'onClick': {} },
            size: "small",
        }));
        const __VLS_55 = __VLS_54({
            ...{ 'onClick': {} },
            size: "small",
        }, ...__VLS_functionalComponentArgsRest(__VLS_54));
        let __VLS_58;
        const __VLS_59 = ({ click: {} },
            { onClick: (__VLS_ctx.cancelEdit) });
        const { default: __VLS_60 } = __VLS_56.slots;
        (__VLS_ctx.t('common.cancel'));
        // @ts-ignore
        [t, t, t, editingSection, editContent, cancelEdit, userEmpty, displayUser,];
        var __VLS_56;
        var __VLS_57;
        let __VLS_61;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_62 = __VLS_asFunctionalComponent1(__VLS_61, new __VLS_61({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }));
        const __VLS_63 = __VLS_62({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }, ...__VLS_functionalComponentArgsRest(__VLS_62));
        let __VLS_66;
        const __VLS_67 = ({ click: {} },
            { onClick: (__VLS_ctx.handleSave) });
        const { default: __VLS_68 } = __VLS_64.slots;
        (__VLS_ctx.t('common.save'));
        // @ts-ignore
        [t, saving, handleSave,];
        var __VLS_64;
        var __VLS_65;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "memory-section" },
    });
    /** @type {__VLS_StyleScopedClasses['memory-section']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-header" },
    });
    /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "section-title-row" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['section-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
        d: "M8 14s1.5 2 4 2 4-2 4-2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "9",
        y1: "9",
        x2: "9.01",
        y2: "9",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "15",
        y1: "9",
        x2: "15.01",
        y2: "9",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "section-title" },
    });
    /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
    (__VLS_ctx.t('memory.soul'));
    if (__VLS_ctx.data?.soul_mtime) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "section-mtime" },
        });
        /** @type {__VLS_StyleScopedClasses['section-mtime']} */ ;
        (__VLS_ctx.formatTime(__VLS_ctx.data.soul_mtime));
    }
    if (__VLS_ctx.editingSection !== 'soul') {
        let __VLS_69;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_70 = __VLS_asFunctionalComponent1(__VLS_69, new __VLS_69({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }));
        const __VLS_71 = __VLS_70({
            ...{ 'onClick': {} },
            size: "tiny",
            quaternary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_70));
        let __VLS_74;
        const __VLS_75 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading && !__VLS_ctx.data))
                        return;
                    if (!(__VLS_ctx.editingSection !== 'soul'))
                        return;
                    __VLS_ctx.startEdit('soul');
                    // @ts-ignore
                    [t, data, data, formatTime, editingSection, startEdit,];
                } });
        const { default: __VLS_76 } = __VLS_72.slots;
        {
            const { icon: __VLS_77 } = __VLS_72.slots;
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
            });
            // @ts-ignore
            [];
        }
        (__VLS_ctx.t('common.edit'));
        // @ts-ignore
        [t,];
        var __VLS_72;
        var __VLS_73;
    }
    if (__VLS_ctx.editingSection !== 'soul') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-body" },
        });
        /** @type {__VLS_StyleScopedClasses['section-body']} */ ;
        if (!__VLS_ctx.soulEmpty) {
            const __VLS_78 = MarkdownRenderer;
            // @ts-ignore
            const __VLS_79 = __VLS_asFunctionalComponent1(__VLS_78, new __VLS_78({
                content: (__VLS_ctx.displaySoul),
            }));
            const __VLS_80 = __VLS_79({
                content: (__VLS_ctx.displaySoul),
            }, ...__VLS_functionalComponentArgsRest(__VLS_79));
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "empty-text" },
            });
            /** @type {__VLS_StyleScopedClasses['empty-text']} */ ;
            (__VLS_ctx.t('memory.noSoul'));
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-edit" },
        });
        /** @type {__VLS_StyleScopedClasses['section-edit']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            value: (__VLS_ctx.editContent),
            ...{ class: "edit-textarea" },
            placeholder: (__VLS_ctx.t('memory.soulPlaceholder')),
            spellcheck: "false",
        });
        /** @type {__VLS_StyleScopedClasses['edit-textarea']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "edit-actions" },
        });
        /** @type {__VLS_StyleScopedClasses['edit-actions']} */ ;
        let __VLS_83;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_84 = __VLS_asFunctionalComponent1(__VLS_83, new __VLS_83({
            ...{ 'onClick': {} },
            size: "small",
        }));
        const __VLS_85 = __VLS_84({
            ...{ 'onClick': {} },
            size: "small",
        }, ...__VLS_functionalComponentArgsRest(__VLS_84));
        let __VLS_88;
        const __VLS_89 = ({ click: {} },
            { onClick: (__VLS_ctx.cancelEdit) });
        const { default: __VLS_90 } = __VLS_86.slots;
        (__VLS_ctx.t('common.cancel'));
        // @ts-ignore
        [t, t, t, editingSection, editContent, cancelEdit, soulEmpty, displaySoul,];
        var __VLS_86;
        var __VLS_87;
        let __VLS_91;
        /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
        NButton;
        // @ts-ignore
        const __VLS_92 = __VLS_asFunctionalComponent1(__VLS_91, new __VLS_91({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }));
        const __VLS_93 = __VLS_92({
            ...{ 'onClick': {} },
            size: "small",
            type: "primary",
            loading: (__VLS_ctx.saving),
        }, ...__VLS_functionalComponentArgsRest(__VLS_92));
        let __VLS_96;
        const __VLS_97 = ({ click: {} },
            { onClick: (__VLS_ctx.handleSave) });
        const { default: __VLS_98 } = __VLS_94.slots;
        (__VLS_ctx.t('common.save'));
        // @ts-ignore
        [t, saving, handleSave,];
        var __VLS_94;
        var __VLS_95;
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
