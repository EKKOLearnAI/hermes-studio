/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import thinkingVideoLight from "@/assets/thinking-light.mp4";
import thinkingVideoDark from "@/assets/thinking-dark.mp4";
import { useTheme } from "@/composables/useTheme";
const chatStore = useChatStore();
const { t } = useI18n();
const { isDark } = useTheme();
const listRef = ref();
const displayMessages = computed(() => chatStore.messages.filter((m) => m.role !== "tool"));
const currentToolCalls = computed(() => {
    const msgs = chatStore.messages;
    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
            lastUserIdx = i;
            break;
        }
    }
    // Only tool calls after the last user message, newest on top
    const tools = msgs.filter((m, i) => m.role === "tool" && i > lastUserIdx);
    return [...tools].reverse();
});
function isNearBottom(threshold = 200) {
    const el = listRef.value;
    if (!el)
        return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}
function scrollToBottom() {
    nextTick(() => {
        if (listRef.value) {
            listRef.value.scrollTop = listRef.value.scrollHeight;
        }
    });
}
// Scroll to bottom once when messages are first loaded
watch(() => chatStore.activeSessionId, (id) => {
    if (id)
        scrollToBottom();
}, { immediate: true });
// When a run starts (user just sent a message), always scroll to bottom once
watch(() => chatStore.isRunActive, (v) => {
    if (v)
        scrollToBottom();
});
// During streaming, only auto-scroll if the user is already near the bottom
watch(() => chatStore.messages[chatStore.messages.length - 1]?.content, () => {
    if (!chatStore.isStreaming) {
        scrollToBottom();
        return;
    }
    if (!isNearBottom())
        return;
    scrollToBottom();
});
watch(currentToolCalls, () => {
    if (!chatStore.isStreaming) {
        scrollToBottom();
        return;
    }
    if (!isNearBottom())
        return;
    scrollToBottom();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['dark']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ref: "listRef",
    ...{ class: "message-list" },
});
/** @type {__VLS_StyleScopedClasses['message-list']} */ ;
if (__VLS_ctx.chatStore.messages.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-state" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
        src: "/logo.png",
        alt: "Hermes",
        ...{ class: "empty-logo" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-logo']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.t("chat.emptyState"));
}
for (const [msg] of __VLS_vFor((__VLS_ctx.displayMessages))) {
    const __VLS_0 = MessageItem;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        key: (msg.id),
        message: (msg),
    }));
    const __VLS_2 = __VLS_1({
        key: (msg.id),
        message: (msg),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    // @ts-ignore
    [chatStore, t, displayMessages,];
}
let __VLS_5;
/** @ts-ignore @type {typeof __VLS_components.Transition | typeof __VLS_components.Transition} */
Transition;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
    name: "fade",
}));
const __VLS_7 = __VLS_6({
    name: "fade",
}, ...__VLS_functionalComponentArgsRest(__VLS_6));
const { default: __VLS_10 } = __VLS_8.slots;
if (__VLS_ctx.chatStore.isRunActive) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "streaming-indicator" },
    });
    /** @type {__VLS_StyleScopedClasses['streaming-indicator']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.video)({
        src: (__VLS_ctx.isDark ? __VLS_ctx.thinkingVideoDark : __VLS_ctx.thinkingVideoLight),
        autoplay: true,
        loop: true,
        muted: true,
        playsinline: true,
        ...{ class: "thinking-video" },
    });
    /** @type {__VLS_StyleScopedClasses['thinking-video']} */ ;
    if (__VLS_ctx.currentToolCalls.length > 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tool-calls-panel" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-calls-panel']} */ ;
        for (const [tc] of __VLS_vFor((__VLS_ctx.currentToolCalls))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (tc.id),
                ...{ class: "tool-call-item" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-call-item']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                width: "12",
                height: "12",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "1.5",
                ...{ class: "tool-call-icon" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-call-icon']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "tool-call-name" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-call-name']} */ ;
            (tc.toolName);
            if (tc.toolPreview) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "tool-call-preview" },
                });
                /** @type {__VLS_StyleScopedClasses['tool-call-preview']} */ ;
                (tc.toolPreview);
            }
            if (tc.toolStatus === 'running') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "tool-call-spinner" },
                });
                /** @type {__VLS_StyleScopedClasses['tool-call-spinner']} */ ;
            }
            if (tc.toolStatus === 'error') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "tool-call-error" },
                });
                /** @type {__VLS_StyleScopedClasses['tool-call-error']} */ ;
                (__VLS_ctx.t("chat.error"));
            }
            // @ts-ignore
            [chatStore, t, isDark, thinkingVideoDark, thinkingVideoLight, currentToolCalls, currentToolCalls,];
        }
    }
}
// @ts-ignore
[];
var __VLS_8;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
