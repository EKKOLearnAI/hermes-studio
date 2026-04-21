/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted, onUnmounted } from 'vue';
import { NInput } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import SkillList from '@/components/hermes/skills/SkillList.vue';
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue';
import { fetchSkills } from '@/api/hermes/skills';
const { t } = useI18n();
const categories = ref([]);
const loading = ref(false);
const selectedCategory = ref('');
const selectedSkill = ref('');
const searchQuery = ref('');
const showSidebar = ref(true);
let mobileQuery = null;
function handleMobileChange(e) {
    showSidebar.value = !e.matches;
}
onMounted(() => {
    mobileQuery = window.matchMedia('(max-width: 768px)');
    handleMobileChange(mobileQuery);
    mobileQuery.addEventListener('change', handleMobileChange);
    loadSkills();
});
onUnmounted(() => {
    mobileQuery?.removeEventListener('change', handleMobileChange);
});
async function loadSkills() {
    loading.value = true;
    try {
        categories.value = await fetchSkills();
    }
    catch (err) {
        console.error('Failed to load skills:', err);
    }
    finally {
        loading.value = false;
    }
}
function handleSelect(category, skill) {
    selectedCategory.value = category;
    selectedSkill.value = skill;
    if (window.innerWidth <= 768) {
        showSidebar.value = false;
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['sidebar-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['skills-sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['skills-layout']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "skills-view" },
});
/** @type {__VLS_StyleScopedClasses['skills-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "page-header" },
});
/** @type {__VLS_StyleScopedClasses['page-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "header-title" },
});
/** @type {__VLS_StyleScopedClasses['header-title']} */ ;
(__VLS_ctx.t('skills.title'));
if (!__VLS_ctx.showSidebar) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(!__VLS_ctx.showSidebar))
                    return;
                __VLS_ctx.showSidebar = true;
                // @ts-ignore
                [t, showSidebar, showSidebar,];
            } },
        ...{ class: "sidebar-toggle" },
    });
    /** @type {__VLS_StyleScopedClasses['sidebar-toggle']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "3",
        y1: "12",
        x2: "21",
        y2: "12",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "3",
        y1: "6",
        x2: "21",
        y2: "6",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "3",
        y1: "18",
        x2: "21",
        y2: "18",
    });
}
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    value: (__VLS_ctx.searchQuery),
    placeholder: (__VLS_ctx.t('skills.searchPlaceholder')),
    size: "small",
    clearable: true,
    ...{ style: {} },
}));
const __VLS_2 = __VLS_1({
    value: (__VLS_ctx.searchQuery),
    placeholder: (__VLS_ctx.t('skills.searchPlaceholder')),
    size: "small",
    clearable: true,
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "skills-content" },
});
/** @type {__VLS_StyleScopedClasses['skills-content']} */ ;
if (__VLS_ctx.loading && __VLS_ctx.categories.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skills-loading" },
    });
    /** @type {__VLS_StyleScopedClasses['skills-loading']} */ ;
    (__VLS_ctx.t('common.loading'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skills-layout" },
    });
    /** @type {__VLS_StyleScopedClasses['skills-layout']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && __VLS_ctx.categories.length === 0))
                    return;
                __VLS_ctx.showSidebar = false;
                // @ts-ignore
                [t, t, showSidebar, searchQuery, loading, categories,];
            } },
        ...{ class: "mobile-backdrop" },
        ...{ class: ({ active: __VLS_ctx.showSidebar }) },
    });
    /** @type {__VLS_StyleScopedClasses['mobile-backdrop']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    if (__VLS_ctx.showSidebar) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "skills-sidebar" },
        });
        /** @type {__VLS_StyleScopedClasses['skills-sidebar']} */ ;
        const __VLS_5 = SkillList;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
            ...{ 'onSelect': {} },
            categories: (__VLS_ctx.categories),
            selectedSkill: (__VLS_ctx.selectedCategory && __VLS_ctx.selectedSkill ? `${__VLS_ctx.selectedCategory}/${__VLS_ctx.selectedSkill}` : null),
            searchQuery: (__VLS_ctx.searchQuery),
        }));
        const __VLS_7 = __VLS_6({
            ...{ 'onSelect': {} },
            categories: (__VLS_ctx.categories),
            selectedSkill: (__VLS_ctx.selectedCategory && __VLS_ctx.selectedSkill ? `${__VLS_ctx.selectedCategory}/${__VLS_ctx.selectedSkill}` : null),
            searchQuery: (__VLS_ctx.searchQuery),
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
        let __VLS_10;
        const __VLS_11 = ({ select: {} },
            { onSelect: (__VLS_ctx.handleSelect) });
        var __VLS_8;
        var __VLS_9;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skills-main" },
    });
    /** @type {__VLS_StyleScopedClasses['skills-main']} */ ;
    if (__VLS_ctx.selectedCategory && __VLS_ctx.selectedSkill) {
        const __VLS_12 = SkillDetail;
        // @ts-ignore
        const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
            category: (__VLS_ctx.selectedCategory),
            skill: (__VLS_ctx.selectedSkill),
        }));
        const __VLS_14 = __VLS_13({
            category: (__VLS_ctx.selectedCategory),
            skill: (__VLS_ctx.selectedSkill),
        }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "empty-detail" },
        });
        /** @type {__VLS_StyleScopedClasses['empty-detail']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "48",
            height: "48",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "1",
            opacity: "0.2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polygon)({
            points: "12 2 2 7 12 12 22 7 12 2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "2 17 12 22 22 17",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "2 12 12 17 22 12",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        (__VLS_ctx.t('skills.noMatch'));
    }
}
// @ts-ignore
[t, showSidebar, showSidebar, searchQuery, categories, selectedCategory, selectedCategory, selectedCategory, selectedCategory, selectedSkill, selectedSkill, selectedSkill, selectedSkill, handleSelect,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
