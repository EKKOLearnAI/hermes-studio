/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed } from 'vue';
import { NSwitch, useMessage } from 'naive-ui';
import { toggleSkill } from '@/api/hermes/skills';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const message = useMessage();
const props = defineProps();
const emit = defineEmits();
const collapsedCategories = ref(new Set());
const togglingSkills = ref(new Set());
const filteredCategories = computed(() => {
    if (!props.searchQuery)
        return props.categories;
    const q = props.searchQuery.toLowerCase();
    return props.categories
        .map(cat => ({
        ...cat,
        skills: cat.skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    }))
        .filter(cat => cat.skills.length > 0 || cat.name.toLowerCase().includes(q));
});
function toggleCategory(name) {
    if (collapsedCategories.value.has(name)) {
        collapsedCategories.value.delete(name);
    }
    else {
        collapsedCategories.value.add(name);
    }
}
function handleSelect(category, skill) {
    emit('select', category, skill);
}
async function handleToggle(category, skillName, newEnabled) {
    if (togglingSkills.value.has(skillName))
        return;
    togglingSkills.value.add(skillName);
    try {
        await toggleSkill(skillName, newEnabled);
        // Update local state
        const cat = props.categories.find(c => c.name === category);
        const skill = cat?.skills.find(s => s.name === skillName);
        if (skill)
            skill.enabled = newEnabled;
    }
    catch (err) {
        message.error(t('skills.toggleFailed') + `: ${err.message}`);
    }
    finally {
        togglingSkills.value.delete(skillName);
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
    ...{ class: "skill-list" },
});
/** @type {__VLS_StyleScopedClasses['skill-list']} */ ;
if (__VLS_ctx.filteredCategories.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skill-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['skill-empty']} */ ;
    (__VLS_ctx.searchQuery ? __VLS_ctx.t('skills.noMatch') : __VLS_ctx.t('skills.noSkills'));
}
for (const [cat] of __VLS_vFor((__VLS_ctx.filteredCategories))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (cat.name),
        ...{ class: "skill-category" },
    });
    /** @type {__VLS_StyleScopedClasses['skill-category']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.toggleCategory(cat.name);
                // @ts-ignore
                [filteredCategories, filteredCategories, searchQuery, t, t, toggleCategory,];
            } },
        ...{ class: "category-header" },
    });
    /** @type {__VLS_StyleScopedClasses['category-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "12",
        height: "12",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
        ...{ class: "category-arrow" },
        ...{ class: ({ collapsed: __VLS_ctx.collapsedCategories.has(cat.name) }) },
    });
    /** @type {__VLS_StyleScopedClasses['category-arrow']} */ ;
    /** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
        points: "6 9 12 15 18 9",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "category-name" },
    });
    /** @type {__VLS_StyleScopedClasses['category-name']} */ ;
    (cat.name);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "category-count" },
    });
    /** @type {__VLS_StyleScopedClasses['category-count']} */ ;
    (cat.skills.length);
    if (!__VLS_ctx.collapsedCategories.has(cat.name)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "category-skills" },
        });
        /** @type {__VLS_StyleScopedClasses['category-skills']} */ ;
        for (const [skill] of __VLS_vFor((cat.skills))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(!__VLS_ctx.collapsedCategories.has(cat.name)))
                            return;
                        __VLS_ctx.handleSelect(cat.name, skill.name);
                        // @ts-ignore
                        [collapsedCategories, collapsedCategories, handleSelect,];
                    } },
                key: (skill.name),
                ...{ class: "skill-item" },
                ...{ class: ({
                        active: __VLS_ctx.selectedSkill === `${cat.name}/${skill.name}`,
                    }) },
            });
            /** @type {__VLS_StyleScopedClasses['skill-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "skill-info" },
            });
            /** @type {__VLS_StyleScopedClasses['skill-info']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "skill-name" },
            });
            /** @type {__VLS_StyleScopedClasses['skill-name']} */ ;
            (skill.name);
            if (skill.description) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "skill-desc" },
                });
                /** @type {__VLS_StyleScopedClasses['skill-desc']} */ ;
                (skill.description);
            }
            let __VLS_0;
            /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
            NSwitch;
            // @ts-ignore
            const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
                ...{ 'onUpdate:value': {} },
                ...{ 'onClick': {} },
                size: "small",
                value: (skill.enabled !== false),
                loading: (__VLS_ctx.togglingSkills.has(skill.name)),
            }));
            const __VLS_2 = __VLS_1({
                ...{ 'onUpdate:value': {} },
                ...{ 'onClick': {} },
                size: "small",
                value: (skill.enabled !== false),
                loading: (__VLS_ctx.togglingSkills.has(skill.name)),
            }, ...__VLS_functionalComponentArgsRest(__VLS_1));
            let __VLS_5;
            const __VLS_6 = ({ 'update:value': {} },
                { 'onUpdate:value': (...[$event]) => {
                        if (!(!__VLS_ctx.collapsedCategories.has(cat.name)))
                            return;
                        __VLS_ctx.handleToggle(cat.name, skill.name, $event);
                        // @ts-ignore
                        [selectedSkill, togglingSkills, handleToggle,];
                    } });
            const __VLS_7 = ({ click: {} },
                { onClick: () => { } });
            var __VLS_3;
            var __VLS_4;
            // @ts-ignore
            [];
        }
    }
    // @ts-ignore
    [];
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
