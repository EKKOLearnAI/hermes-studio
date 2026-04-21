/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import { copyTextToClipboard, handleCodeBlockCopyClick, renderHighlightedCodeBlock, } from "./highlight";
const TOOL_PAYLOAD_DISPLAY_LIMIT = 2000;
const props = defineProps();
const { t } = useI18n();
const isSystem = computed(() => props.message.role === "system");
const toolExpanded = ref(false);
const timeStr = computed(() => {
    const d = new Date(props.message.timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});
function isImage(type) {
    return type.startsWith("image/");
}
function formatSize(bytes) {
    if (bytes < 1024)
        return bytes + " B";
    if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function formatToolPayload(raw) {
    if (!raw) {
        return { full: "", display: "" };
    }
    try {
        const full = JSON.stringify(JSON.parse(raw), null, 2);
        return {
            full,
            display: full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
                ? full.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
                : full,
            language: "json",
        };
    }
    catch {
        return {
            full: raw,
            display: raw.length > TOOL_PAYLOAD_DISPLAY_LIMIT
                ? raw.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
                : raw,
        };
    }
}
function renderToolPayload(content, language) {
    return renderHighlightedCodeBlock(content, language, t("common.copy"), {
        maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
    });
}
async function handleToolDetailClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement))
        return;
    const button = target.closest("[data-copy-code=\"true\"]");
    if (!button)
        return;
    event.preventDefault();
    const source = button.closest("[data-copy-source]")?.dataset.copySource;
    if (source === "tool-args" && fullToolArgs.value) {
        await copyTextToClipboard(fullToolArgs.value);
        return;
    }
    if (source === "tool-result" && fullToolResult.value) {
        await copyTextToClipboard(fullToolResult.value);
        return;
    }
    await handleCodeBlockCopyClick(event);
}
const hasAttachments = computed(() => (props.message.attachments?.length ?? 0) > 0);
const hasToolDetails = computed(() => !!(props.message.toolArgs || props.message.toolResult));
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult));
const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);
const renderedToolArgs = computed(() => {
    if (!formattedToolArgs.value)
        return "";
    return renderToolPayload(formattedToolArgs.value, toolArgsPayload.value.language);
});
const renderedToolResult = computed(() => {
    if (!formattedToolResult.value)
        return "";
    return renderToolPayload(formattedToolResult.value, toolResultPayload.value.language);
});
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['system']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['message']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
/** @type {__VLS_StyleScopedClasses['message']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
/** @type {__VLS_StyleScopedClasses['message']} */ ;
/** @type {__VLS_StyleScopedClasses['system']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "message" },
    ...{ class: ([__VLS_ctx.message.role]) },
});
/** @type {__VLS_StyleScopedClasses['message']} */ ;
if (__VLS_ctx.message.role === 'tool') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.message.role === 'tool'))
                    return;
                __VLS_ctx.hasToolDetails && (__VLS_ctx.toolExpanded = !__VLS_ctx.toolExpanded);
                // @ts-ignore
                [message, message, hasToolDetails, toolExpanded, toolExpanded,];
            } },
        ...{ class: "tool-line" },
        ...{ class: ({ expandable: __VLS_ctx.hasToolDetails }) },
    });
    /** @type {__VLS_StyleScopedClasses['tool-line']} */ ;
    /** @type {__VLS_StyleScopedClasses['expandable']} */ ;
    if (__VLS_ctx.hasToolDetails) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "10",
            height: "10",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2",
            ...{ class: "tool-chevron" },
            ...{ class: ({ rotated: __VLS_ctx.toolExpanded }) },
        });
        /** @type {__VLS_StyleScopedClasses['tool-chevron']} */ ;
        /** @type {__VLS_StyleScopedClasses['rotated']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "9 18 15 12 9 6",
        });
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "12",
            height: "12",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "1.5",
            ...{ class: "tool-icon" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
            d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        });
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tool-name" },
    });
    /** @type {__VLS_StyleScopedClasses['tool-name']} */ ;
    (__VLS_ctx.message.toolName);
    if (__VLS_ctx.message.toolPreview && !__VLS_ctx.toolExpanded) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tool-preview" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-preview']} */ ;
        (__VLS_ctx.message.toolPreview);
    }
    if (__VLS_ctx.message.toolStatus === 'running') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tool-spinner" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-spinner']} */ ;
    }
    if (__VLS_ctx.message.toolStatus === 'error') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tool-error-badge" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-error-badge']} */ ;
        (__VLS_ctx.t("chat.error"));
    }
    if (__VLS_ctx.toolExpanded && __VLS_ctx.hasToolDetails) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (__VLS_ctx.handleToolDetailClick) },
            ...{ class: "tool-details" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-details']} */ ;
        if (__VLS_ctx.formattedToolArgs) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-section" },
                'data-copy-source': "tool-args",
            });
            /** @type {__VLS_StyleScopedClasses['tool-detail-section']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-label" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-detail-label']} */ ;
            (__VLS_ctx.t("chat.arguments"));
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-code-block" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderedToolArgs) }, null, null);
            /** @type {__VLS_StyleScopedClasses['tool-detail-code-block']} */ ;
        }
        if (__VLS_ctx.formattedToolResult) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-section" },
                'data-copy-source': "tool-result",
            });
            /** @type {__VLS_StyleScopedClasses['tool-detail-section']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-label" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-detail-label']} */ ;
            (__VLS_ctx.t("chat.result"));
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-detail-code-block" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderedToolResult) }, null, null);
            /** @type {__VLS_StyleScopedClasses['tool-detail-code-block']} */ ;
        }
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg-body" },
    });
    /** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
    if (__VLS_ctx.message.role === 'assistant') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
            src: "/logo.png",
            alt: "Hermes",
            ...{ class: "msg-avatar" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg-content" },
        ...{ class: (__VLS_ctx.message.role) },
    });
    /** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message-bubble" },
        ...{ class: ({ system: __VLS_ctx.isSystem }) },
    });
    /** @type {__VLS_StyleScopedClasses['message-bubble']} */ ;
    /** @type {__VLS_StyleScopedClasses['system']} */ ;
    if (__VLS_ctx.hasAttachments) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-attachments" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-attachments']} */ ;
        for (const [att] of __VLS_vFor((__VLS_ctx.message.attachments))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (att.id),
                ...{ class: "msg-attachment" },
                ...{ class: ({ image: __VLS_ctx.isImage(att.type) }) },
            });
            /** @type {__VLS_StyleScopedClasses['msg-attachment']} */ ;
            /** @type {__VLS_StyleScopedClasses['image']} */ ;
            if (__VLS_ctx.isImage(att.type) && att.url) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
                    src: (att.url),
                    alt: (att.name),
                    ...{ class: "msg-attachment-thumb" },
                });
                /** @type {__VLS_StyleScopedClasses['msg-attachment-thumb']} */ ;
            }
            else {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "msg-attachment-file" },
                });
                /** @type {__VLS_StyleScopedClasses['msg-attachment-file']} */ ;
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
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "att-name" },
                });
                /** @type {__VLS_StyleScopedClasses['att-name']} */ ;
                (att.name);
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "att-size" },
                });
                /** @type {__VLS_StyleScopedClasses['att-size']} */ ;
                (__VLS_ctx.formatSize(att.size));
            }
            // @ts-ignore
            [message, message, message, message, message, message, message, message, hasToolDetails, hasToolDetails, hasToolDetails, toolExpanded, toolExpanded, toolExpanded, t, t, t, handleToolDetailClick, formattedToolArgs, renderedToolArgs, formattedToolResult, renderedToolResult, isSystem, hasAttachments, isImage, isImage, formatSize,];
        }
    }
    if (__VLS_ctx.message.content) {
        const __VLS_0 = MarkdownRenderer;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            content: (__VLS_ctx.message.content),
        }));
        const __VLS_2 = __VLS_1({
            content: (__VLS_ctx.message.content),
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    }
    if (__VLS_ctx.message.isStreaming && !__VLS_ctx.message.content) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "streaming-dots" },
        });
        /** @type {__VLS_StyleScopedClasses['streaming-dots']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "message-time" },
    });
    /** @type {__VLS_StyleScopedClasses['message-time']} */ ;
    (__VLS_ctx.timeStr);
}
// @ts-ignore
[message, message, message, message, timeStr,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeProps: {},
});
export default {};
