/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import MarkdownIt from 'markdown-it';
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight';
const props = defineProps();
const { t } = useI18n();
const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight(str, lang) {
        return renderHighlightedCodeBlock(str, lang, t('common.copy'));
    },
});
const renderedHtml = computed(() => md.render(props.content));
function handleMarkdownClick(event) {
    void handleCodeBlockCopyClick(event);
}
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
    ...{ onClick: (__VLS_ctx.handleMarkdownClick) },
    ...{ class: "markdown-body" },
});
__VLS_asFunctionalDirective(__VLS_directives.vHtml, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderedHtml) }, null, null);
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
// @ts-ignore
[handleMarkdownClick, renderedHtml,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeProps: {},
});
export default {};
