/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, watch } from 'vue';
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue';
import { fetchSkillContent, fetchSkillFiles } from '@/api/hermes/skills';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const props = defineProps();
const content = ref('');
const files = ref([]);
const loading = ref(false);
const fileContent = ref('');
const viewingFile = ref(null);
const fileLoading = ref(false);
async function loadSkill() {
    loading.value = true;
    viewingFile.value = null;
    fileContent.value = '';
    files.value = [];
    content.value = '';
    try {
        const skillPath = `${props.category}/${props.skill}/SKILL.md`;
        const [skillContent, skillFiles] = await Promise.all([
            fetchSkillContent(skillPath),
            fetchSkillFiles(props.category, props.skill),
        ]);
        content.value = skillContent;
        files.value = skillFiles.filter(f => !f.isDir && f.path !== 'SKILL.md');
    }
    catch (err) {
        content.value = t('skills.loadFailed') + `: ${err.message}`;
    }
    finally {
        loading.value = false;
    }
}
async function viewFile(filePath) {
    fileLoading.value = true;
    viewingFile.value = filePath;
    try {
        // filePath might be absolute or relative; normalize to relative under category/skill/
        const base = `${props.category}/${props.skill}/`;
        let relPath = filePath;
        if (filePath.startsWith('/')) {
            // Strip absolute prefix to get relative path
            const segments = filePath.split('/.hermes/skills/')[1];
            if (segments) {
                const afterSkillDir = segments.split('/').slice(2).join('/');
                relPath = afterSkillDir;
            }
        }
        fileContent.value = await fetchSkillContent(`${base}${relPath}`);
    }
    catch (err) {
        fileContent.value = t('skills.fileLoadFailed') + `: ${err.message}`;
    }
    finally {
        fileLoading.value = false;
    }
}
function backToSkill() {
    viewingFile.value = null;
    fileContent.value = '';
}
watch(() => `${props.category}/${props.skill}`, loadSkill, { immediate: true });
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "skill-detail" },
});
/** @type {__VLS_StyleScopedClasses['skill-detail']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "detail-title" },
});
/** @type {__VLS_StyleScopedClasses['detail-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "detail-category" },
});
/** @type {__VLS_StyleScopedClasses['detail-category']} */ ;
(__VLS_ctx.category);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "detail-separator" },
});
/** @type {__VLS_StyleScopedClasses['detail-separator']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "detail-name" },
});
/** @type {__VLS_StyleScopedClasses['detail-name']} */ ;
(__VLS_ctx.skill);
if (__VLS_ctx.loading && !__VLS_ctx.content) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "detail-loading" },
    });
    /** @type {__VLS_StyleScopedClasses['detail-loading']} */ ;
    (__VLS_ctx.t('common.loading'));
}
else {
    if (__VLS_ctx.viewingFile) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-breadcrumb" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-breadcrumb']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.backToSkill) },
            ...{ class: "back-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['back-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "15 18 9 12 15 6",
        });
        (__VLS_ctx.t('skills.backTo'));
        (__VLS_ctx.skill);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "breadcrumb-path" },
        });
        /** @type {__VLS_StyleScopedClasses['breadcrumb-path']} */ ;
        (__VLS_ctx.viewingFile);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "detail-content" },
    });
    /** @type {__VLS_StyleScopedClasses['detail-content']} */ ;
    if (__VLS_ctx.viewingFile) {
        const __VLS_0 = MarkdownRenderer;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            content: (__VLS_ctx.fileContent),
        }));
        const __VLS_2 = __VLS_1({
            content: (__VLS_ctx.fileContent),
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    }
    else {
        const __VLS_5 = MarkdownRenderer;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
            content: (__VLS_ctx.content),
        }));
        const __VLS_7 = __VLS_6({
            content: (__VLS_ctx.content),
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    }
    if (!__VLS_ctx.viewingFile && __VLS_ctx.files.length > 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-files" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-files']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "files-header" },
        });
        /** @type {__VLS_StyleScopedClasses['files-header']} */ ;
        (__VLS_ctx.t('skills.attachedFiles'));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "files-list" },
        });
        /** @type {__VLS_StyleScopedClasses['files-list']} */ ;
        for (const [f] of __VLS_vFor((__VLS_ctx.files))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.content))
                            return;
                        if (!(!__VLS_ctx.viewingFile && __VLS_ctx.files.length > 0))
                            return;
                        __VLS_ctx.viewFile(f.path);
                        // @ts-ignore
                        [category, skill, skill, loading, content, content, t, t, t, viewingFile, viewingFile, viewingFile, viewingFile, backToSkill, fileContent, files, files, viewFile,];
                    } },
                key: (f.path),
                ...{ class: "file-item" },
            });
            /** @type {__VLS_StyleScopedClasses['file-item']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                width: "14",
                height: "14",
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
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            (f.path);
            // @ts-ignore
            [];
        }
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeProps: {},
});
export default {};
