/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { renameSession } from '@/api/hermes/sessions';
import { useChatStore } from '@/stores/hermes/chat';
import { NButton, NDropdown, NInput, NModal, NPopconfirm, NTooltip, useMessage } from 'naive-ui';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatInput from './ChatInput.vue';
import MessageList from './MessageList.vue';
const chatStore = useChatStore();
const message = useMessage();
const { t } = useI18n();
// Initialize synchronously from the media query so first paint is correct.
// On narrow viewports the session list is an absolute-positioned overlay
// (z-index 10) on top of the chat area; if we default to `true`, onMounted
// only flips it to `false` AFTER the first render, causing a visible flash
// where the session list covers the chat content ("auto-fixes after a
// moment" — that was the race).
const showSessions = ref(typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches);
let mobileQuery = null;
function handleSessionClick(sessionId) {
    chatStore.switchSession(sessionId);
    if (mobileQuery?.matches)
        showSessions.value = false;
}
function handleMobileChange(e) {
    if (e.matches && showSessions.value) {
        showSessions.value = false;
    }
}
onMounted(() => {
    mobileQuery = window.matchMedia('(max-width: 768px)');
    handleMobileChange(mobileQuery);
    mobileQuery.addEventListener('change', handleMobileChange);
});
onUnmounted(() => {
    mobileQuery?.removeEventListener('change', handleMobileChange);
});
const showRenameModal = ref(false);
const renameValue = ref('');
const renameSessionId = ref(null);
const renameInputRef = ref(null);
const collapsedGroups = ref(new Set(JSON.parse(localStorage.getItem('hermes_collapsed_groups') || '[]')));
const sourceLabelKeys = {
    telegram: 'Telegram',
    api_server: 'API Server',
    cli: 'CLI',
    discord: 'Discord',
    slack: 'Slack',
    matrix: 'Matrix',
    whatsapp: 'WhatsApp',
    signal: 'Signal',
    email: 'Email',
    sms: 'SMS',
    dingtalk: 'DingTalk',
    feishu: 'Feishu',
    wecom: 'WeCom',
    weixin: 'WeChat',
    bluebubbles: 'iMessage',
    mattermost: 'Mattermost',
    cron: 'Cron',
};
function getSourceLabel(source) {
    if (!source)
        return '';
    return sourceLabelKeys[source] || source;
}
// Source sort order: api_server first, cron last, others alphabetical
function sourceSortKey(source) {
    if (source === 'api_server')
        return -1;
    if (source === 'cron')
        return 999;
    return 0;
}
function sortSessionsWithActiveFirst(items) {
    return [...items].sort((a, b) => {
        const aLive = chatStore.isSessionLive(a.id);
        const bLive = chatStore.isSessionLive(b.id);
        if (aLive !== bLive)
            return aLive ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}
const groupedSessions = computed(() => {
    const map = new Map();
    for (const s of chatStore.sessions) {
        const key = s.source || '';
        if (!map.has(key))
            map.set(key, []);
        map.get(key).push(s);
    }
    const keys = [...map.keys()].sort((a, b) => {
        const aHasLive = map.get(a)?.some(s => chatStore.isSessionLive(s.id)) || false;
        const bHasLive = map.get(b)?.some(s => chatStore.isSessionLive(s.id)) || false;
        if (aHasLive !== bHasLive)
            return aHasLive ? -1 : 1;
        const ka = sourceSortKey(a);
        const kb = sourceSortKey(b);
        if (ka !== kb)
            return ka - kb;
        return a.localeCompare(b);
    });
    return keys.map(key => ({
        source: key,
        label: key ? getSourceLabel(key) : t('chat.other'),
        sessions: sortSessionsWithActiveFirst(map.get(key)),
    }));
});
function toggleGroup(source) {
    const isExpanded = !collapsedGroups.value.has(source);
    if (isExpanded) {
        collapsedGroups.value = new Set([...collapsedGroups.value, source]);
    }
    else {
        collapsedGroups.value = new Set(groupedSessions.value.map(g => g.source).filter(s => s !== source));
        // Auto-select the first session in the expanded group
        const group = groupedSessions.value.find(g => g.source === source);
        if (group?.sessions.length) {
            chatStore.switchSession(group.sessions[0].id);
        }
    }
    localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]));
}
// Ensure the active session's group is expanded
watch(groupedSessions, (groups) => {
    if (localStorage.getItem('hermes_collapsed_groups') !== null) {
        // Has saved state — still ensure active session's group is visible
        const activeSource = chatStore.activeSession?.source;
        if (activeSource && collapsedGroups.value.has(activeSource)) {
            collapsedGroups.value = new Set([...collapsedGroups.value].filter(s => s !== activeSource));
            localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]));
        }
        return;
    }
    // No saved state: expand only the first group
    collapsedGroups.value = new Set(groups.slice(1).map(g => g.source));
    localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]));
}, { once: true });
const activeSessionTitle = computed(() => chatStore.activeSession?.title || t('chat.newChat'));
const totalTokens = computed(() => {
    const input = chatStore.activeSession?.inputTokens ?? 0;
    const output = chatStore.activeSession?.outputTokens ?? 0;
    return input + output;
});
const MODEL_CONTEXT = {
    'claude-opus-4': 200000,
    'claude-sonnet-4': 200000,
    'claude-haiku-4': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-3.5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16385,
    'o1': 200000,
    'o1-mini': 128000,
    'o3': 200000,
    'o3-mini': 200000,
    'o4-mini': 200000,
    'deepseek-chat': 65536,
    'deepseek-reasoner': 65536,
    'gemini-2.5-pro': 1000000,
    'gemini-2.5-flash': 1000000,
    'gemini-2.0-flash': 1000000,
    'glm-4-plus': 128000,
    'glm-4': 128000,
    'qwen-max': 128000,
    'qwen-plus': 128000,
    'qwen-turbo': 128000,
};
const contextWindow = computed(() => {
    const model = chatStore.activeSession?.model || '';
    for (const [key, val] of Object.entries(MODEL_CONTEXT)) {
        if (model.includes(key))
            return val;
    }
    return null;
});
function formatTokens(n) {
    if (n >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'k';
    return String(n);
}
const activeSessionSource = computed(() => chatStore.activeSession?.source || '');
function handleNewChat() {
    chatStore.newChat();
}
function copySessionId(id) {
    const sessionId = id || chatStore.activeSessionId;
    if (sessionId) {
        navigator.clipboard.writeText(sessionId);
        message.success(t('common.copied'));
    }
}
function handleDeleteSession(id) {
    chatStore.deleteSession(id);
    message.success(t('chat.sessionDeleted'));
}
function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday)
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// Context menu
const contextMenuOptions = computed(() => [
    { label: t('chat.rename'), key: 'rename' },
    { label: t('chat.copySessionId'), key: 'copy-id' },
]);
const contextSessionId = ref(null);
function handleContextMenu(e, sessionId) {
    e.preventDefault();
    contextSessionId.value = sessionId;
    showContextMenu.value = true;
    contextMenuX.value = e.clientX;
    contextMenuY.value = e.clientY;
}
const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
function handleContextMenuSelect(key) {
    showContextMenu.value = false;
    if (!contextSessionId.value)
        return;
    if (key === 'copy-id') {
        copySessionId(contextSessionId.value);
    }
    else if (key === 'rename') {
        const session = chatStore.sessions.find(s => s.id === contextSessionId.value);
        renameSessionId.value = contextSessionId.value;
        renameValue.value = session?.title || '';
        showRenameModal.value = true;
        nextTick(() => {
            renameInputRef.value?.focus();
        });
    }
}
function handleClickOutside() {
    showContextMenu.value = false;
}
async function handleRenameConfirm() {
    if (!renameSessionId.value || !renameValue.value.trim())
        return;
    const ok = await renameSession(renameSessionId.value, renameValue.value.trim());
    if (ok) {
        const session = chatStore.sessions.find(s => s.id === renameSessionId.value);
        if (session)
            session.title = renameValue.value.trim();
        if (chatStore.activeSession?.id === renameSessionId.value) {
            chatStore.activeSession.title = renameValue.value.trim();
        }
        message.success(t('chat.renamed'));
    }
    else {
        message.error(t('chat.renameFailed'));
    }
    showRenameModal.value = false;
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['session-close-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['session-item-title']} */ ;
/** @type {__VLS_StyleScopedClasses['session-item-title']} */ ;
/** @type {__VLS_StyleScopedClasses['session-item-delete']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-header']} */ ;
/** @type {__VLS_StyleScopedClasses['context-info']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-panel" },
});
/** @type {__VLS_StyleScopedClasses['chat-panel']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showSessions = false;
            // @ts-ignore
            [showSessions,];
        } },
    ...{ class: "session-backdrop" },
    ...{ class: ({ active: __VLS_ctx.showSessions }) },
});
/** @type {__VLS_StyleScopedClasses['session-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "session-list" },
    ...{ class: ({ collapsed: !__VLS_ctx.showSessions }) },
});
/** @type {__VLS_StyleScopedClasses['session-list']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "session-list-header" },
});
/** @type {__VLS_StyleScopedClasses['session-list-header']} */ ;
if (__VLS_ctx.showSessions) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "session-list-title" },
    });
    /** @type {__VLS_StyleScopedClasses['session-list-title']} */ ;
    (__VLS_ctx.t('chat.sessions'));
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "session-list-actions" },
});
/** @type {__VLS_StyleScopedClasses['session-list-actions']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showSessions = false;
            // @ts-ignore
            [showSessions, showSessions, showSessions, showSessions, t,];
        } },
    ...{ class: "session-close-btn" },
});
/** @type {__VLS_StyleScopedClasses['session-close-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    'stroke-width': "2",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "18",
    y1: "6",
    x2: "6",
    y2: "18",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.line)({
    x1: "6",
    y1: "6",
    x2: "18",
    y2: "18",
});
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "tiny",
    circle: true,
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "tiny",
    circle: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = ({ click: {} },
    { onClick: (__VLS_ctx.handleNewChat) });
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "5",
        x2: "12",
        y2: "19",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "5",
        y1: "12",
        x2: "19",
        y2: "12",
    });
    // @ts-ignore
    [handleNewChat,];
}
// @ts-ignore
[];
var __VLS_3;
var __VLS_4;
if (__VLS_ctx.showSessions) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "session-items" },
    });
    /** @type {__VLS_StyleScopedClasses['session-items']} */ ;
    if (__VLS_ctx.chatStore.isLoadingSessions && __VLS_ctx.chatStore.sessions.length === 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "session-loading" },
        });
        /** @type {__VLS_StyleScopedClasses['session-loading']} */ ;
        (__VLS_ctx.t('common.loading'));
    }
    else if (__VLS_ctx.chatStore.sessions.length === 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "session-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['session-empty']} */ ;
        (__VLS_ctx.t('chat.noSessions'));
    }
    for (const [group] of __VLS_vFor((__VLS_ctx.groupedSessions))) {
        (group.source);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showSessions))
                        return;
                    __VLS_ctx.toggleGroup(group.source);
                    // @ts-ignore
                    [showSessions, t, t, chatStore, chatStore, chatStore, groupedSessions, toggleGroup,];
                } },
            ...{ class: "session-group-header" },
        });
        /** @type {__VLS_StyleScopedClasses['session-group-header']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "10",
            height: "10",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2",
            ...{ class: "group-chevron" },
            ...{ class: ({ collapsed: __VLS_ctx.collapsedGroups.has(group.source) }) },
        });
        /** @type {__VLS_StyleScopedClasses['group-chevron']} */ ;
        /** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline)({
            points: "9 18 15 12 9 6",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "session-group-label" },
        });
        /** @type {__VLS_StyleScopedClasses['session-group-label']} */ ;
        (group.label);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "session-group-count" },
        });
        /** @type {__VLS_StyleScopedClasses['session-group-count']} */ ;
        (group.sessions.length);
        if (!__VLS_ctx.collapsedGroups.has(group.source)) {
            for (const [s] of __VLS_vFor((group.sessions))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.showSessions))
                                return;
                            if (!(!__VLS_ctx.collapsedGroups.has(group.source)))
                                return;
                            __VLS_ctx.handleSessionClick(s.id);
                            // @ts-ignore
                            [collapsedGroups, collapsedGroups, handleSessionClick,];
                        } },
                    ...{ onContextmenu: (...[$event]) => {
                            if (!(__VLS_ctx.showSessions))
                                return;
                            if (!(!__VLS_ctx.collapsedGroups.has(group.source)))
                                return;
                            __VLS_ctx.handleContextMenu($event, s.id);
                            // @ts-ignore
                            [handleContextMenu,];
                        } },
                    key: (s.id),
                    ...{ class: "session-item" },
                    ...{ class: ({ active: s.id === __VLS_ctx.chatStore.activeSessionId, live: __VLS_ctx.chatStore.isSessionLive(s.id) }) },
                });
                /** @type {__VLS_StyleScopedClasses['session-item']} */ ;
                /** @type {__VLS_StyleScopedClasses['active']} */ ;
                /** @type {__VLS_StyleScopedClasses['live']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "session-item-content" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-content']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "session-item-title-row" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-title-row']} */ ;
                if (__VLS_ctx.chatStore.isSessionLive(s.id)) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "session-item-active-indicator" },
                        'aria-hidden': "true",
                    });
                    /** @type {__VLS_StyleScopedClasses['session-item-active-indicator']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                        ...{ class: "session-item-active-spinner" },
                        width: "12",
                        height: "12",
                        viewBox: "0 0 24 24",
                        fill: "none",
                        stroke: "currentColor",
                        'stroke-width': "2",
                        'stroke-linecap': "round",
                    });
                    /** @type {__VLS_StyleScopedClasses['session-item-active-spinner']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
                        cx: "12",
                        cy: "12",
                        r: "8",
                        opacity: "0.2",
                    });
                    __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                        d: "M20 12a8 8 0 0 0-8-8",
                    });
                }
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "session-item-title" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-title']} */ ;
                (s.title);
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "session-item-meta" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-meta']} */ ;
                if (s.model) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "session-item-model" },
                    });
                    /** @type {__VLS_StyleScopedClasses['session-item-model']} */ ;
                    (s.model);
                }
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "session-item-time" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-time']} */ ;
                (__VLS_ctx.formatTime(s.createdAt));
                if (s.id !== __VLS_ctx.chatStore.activeSessionId || __VLS_ctx.chatStore.sessions.length > 1) {
                    let __VLS_9;
                    /** @ts-ignore @type {typeof __VLS_components.NPopconfirm | typeof __VLS_components.NPopconfirm} */
                    NPopconfirm;
                    // @ts-ignore
                    const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
                        ...{ 'onPositiveClick': {} },
                    }));
                    const __VLS_11 = __VLS_10({
                        ...{ 'onPositiveClick': {} },
                    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
                    let __VLS_14;
                    const __VLS_15 = ({ positiveClick: {} },
                        { onPositiveClick: (...[$event]) => {
                                if (!(__VLS_ctx.showSessions))
                                    return;
                                if (!(!__VLS_ctx.collapsedGroups.has(group.source)))
                                    return;
                                if (!(s.id !== __VLS_ctx.chatStore.activeSessionId || __VLS_ctx.chatStore.sessions.length > 1))
                                    return;
                                __VLS_ctx.handleDeleteSession(s.id);
                                // @ts-ignore
                                [chatStore, chatStore, chatStore, chatStore, chatStore, formatTime, handleDeleteSession,];
                            } });
                    const { default: __VLS_16 } = __VLS_12.slots;
                    {
                        const { trigger: __VLS_17 } = __VLS_12.slots;
                        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                            ...{ onClick: () => { } },
                            ...{ class: "session-item-delete" },
                        });
                        /** @type {__VLS_StyleScopedClasses['session-item-delete']} */ ;
                        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                            width: "12",
                            height: "12",
                            viewBox: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            'stroke-width': "2",
                        });
                        __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
                            x1: "18",
                            y1: "6",
                            x2: "6",
                            y2: "18",
                        });
                        __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
                            x1: "6",
                            y1: "6",
                            x2: "18",
                            y2: "18",
                        });
                        // @ts-ignore
                        [];
                    }
                    (__VLS_ctx.t('chat.deleteSession'));
                    // @ts-ignore
                    [t,];
                    var __VLS_12;
                    var __VLS_13;
                }
                // @ts-ignore
                [];
            }
        }
        // @ts-ignore
        [];
    }
}
let __VLS_18;
/** @ts-ignore @type {typeof __VLS_components.NDropdown} */
NDropdown;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
    ...{ 'onSelect': {} },
    ...{ 'onClickoutside': {} },
    placement: "bottom-start",
    trigger: "manual",
    x: (__VLS_ctx.contextMenuX),
    y: (__VLS_ctx.contextMenuY),
    options: (__VLS_ctx.contextMenuOptions),
    show: (__VLS_ctx.showContextMenu),
}));
const __VLS_20 = __VLS_19({
    ...{ 'onSelect': {} },
    ...{ 'onClickoutside': {} },
    placement: "bottom-start",
    trigger: "manual",
    x: (__VLS_ctx.contextMenuX),
    y: (__VLS_ctx.contextMenuY),
    options: (__VLS_ctx.contextMenuOptions),
    show: (__VLS_ctx.showContextMenu),
}, ...__VLS_functionalComponentArgsRest(__VLS_19));
let __VLS_23;
const __VLS_24 = ({ select: {} },
    { onSelect: (__VLS_ctx.handleContextMenuSelect) });
const __VLS_25 = ({ clickoutside: {} },
    { onClickoutside: (__VLS_ctx.handleClickOutside) });
var __VLS_21;
var __VLS_22;
let __VLS_26;
/** @ts-ignore @type {typeof __VLS_components.NModal | typeof __VLS_components.NModal} */
NModal;
// @ts-ignore
const __VLS_27 = __VLS_asFunctionalComponent1(__VLS_26, new __VLS_26({
    ...{ 'onPositiveClick': {} },
    show: (__VLS_ctx.showRenameModal),
    preset: "dialog",
    title: (__VLS_ctx.t('chat.renameSession')),
    positiveText: (__VLS_ctx.t('common.ok')),
    negativeText: (__VLS_ctx.t('common.cancel')),
}));
const __VLS_28 = __VLS_27({
    ...{ 'onPositiveClick': {} },
    show: (__VLS_ctx.showRenameModal),
    preset: "dialog",
    title: (__VLS_ctx.t('chat.renameSession')),
    positiveText: (__VLS_ctx.t('common.ok')),
    negativeText: (__VLS_ctx.t('common.cancel')),
}, ...__VLS_functionalComponentArgsRest(__VLS_27));
let __VLS_31;
const __VLS_32 = ({ positiveClick: {} },
    { onPositiveClick: (__VLS_ctx.handleRenameConfirm) });
const { default: __VLS_33 } = __VLS_29.slots;
let __VLS_34;
/** @ts-ignore @type {typeof __VLS_components.NInput} */
NInput;
// @ts-ignore
const __VLS_35 = __VLS_asFunctionalComponent1(__VLS_34, new __VLS_34({
    ...{ 'onKeydown': {} },
    ref: "renameInputRef",
    value: (__VLS_ctx.renameValue),
    placeholder: (__VLS_ctx.t('chat.enterNewTitle')),
}));
const __VLS_36 = __VLS_35({
    ...{ 'onKeydown': {} },
    ref: "renameInputRef",
    value: (__VLS_ctx.renameValue),
    placeholder: (__VLS_ctx.t('chat.enterNewTitle')),
}, ...__VLS_functionalComponentArgsRest(__VLS_35));
let __VLS_39;
const __VLS_40 = ({ keydown: {} },
    { onKeydown: (__VLS_ctx.handleRenameConfirm) });
var __VLS_41 = {};
var __VLS_37;
var __VLS_38;
// @ts-ignore
[t, t, t, t, contextMenuX, contextMenuY, contextMenuOptions, showContextMenu, handleContextMenuSelect, handleClickOutside, showRenameModal, handleRenameConfirm, handleRenameConfirm, renameValue,];
var __VLS_29;
var __VLS_30;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-main" },
});
/** @type {__VLS_StyleScopedClasses['chat-main']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "chat-header" },
});
/** @type {__VLS_StyleScopedClasses['chat-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-left" },
});
/** @type {__VLS_StyleScopedClasses['header-left']} */ ;
let __VLS_43;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "small",
    circle: true,
}));
const __VLS_45 = __VLS_44({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "small",
    circle: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_44));
let __VLS_48;
const __VLS_49 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.showSessions = !__VLS_ctx.showSessions;
            // @ts-ignore
            [showSessions, showSessions,];
        } });
const { default: __VLS_50 } = __VLS_46.slots;
{
    const { icon: __VLS_51 } = __VLS_46.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "3",
        y: "3",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "14",
        y: "3",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "3",
        y: "14",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "14",
        y: "14",
        width: "7",
        height: "7",
    });
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_46;
var __VLS_47;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "header-session-title" },
});
/** @type {__VLS_StyleScopedClasses['header-session-title']} */ ;
(__VLS_ctx.activeSessionTitle);
if (__VLS_ctx.activeSessionSource) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "source-badge" },
    });
    /** @type {__VLS_StyleScopedClasses['source-badge']} */ ;
    (__VLS_ctx.getSourceLabel(__VLS_ctx.activeSessionSource));
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-actions" },
});
/** @type {__VLS_StyleScopedClasses['header-actions']} */ ;
let __VLS_52;
/** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
NTooltip;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent1(__VLS_52, new __VLS_52({
    trigger: "hover",
}));
const __VLS_54 = __VLS_53({
    trigger: "hover",
}, ...__VLS_functionalComponentArgsRest(__VLS_53));
const { default: __VLS_57 } = __VLS_55.slots;
{
    const { trigger: __VLS_58 } = __VLS_55.slots;
    let __VLS_59;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_60 = __VLS_asFunctionalComponent1(__VLS_59, new __VLS_59({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "small",
        circle: true,
    }));
    const __VLS_61 = __VLS_60({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "small",
        circle: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_60));
    let __VLS_64;
    const __VLS_65 = ({ click: {} },
        { onClick: (...[$event]) => {
                __VLS_ctx.copySessionId();
                // @ts-ignore
                [activeSessionTitle, activeSessionSource, activeSessionSource, getSourceLabel, copySessionId,];
            } });
    const { default: __VLS_66 } = __VLS_62.slots;
    {
        const { icon: __VLS_67 } = __VLS_62.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
            x: "9",
            y: "9",
            width: "13",
            height: "13",
            rx: "2",
            ry: "2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
            d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
        });
        // @ts-ignore
        [];
    }
    // @ts-ignore
    [];
    var __VLS_62;
    var __VLS_63;
    // @ts-ignore
    [];
}
(__VLS_ctx.t('chat.copySessionId'));
// @ts-ignore
[t,];
var __VLS_55;
let __VLS_68;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_69 = __VLS_asFunctionalComponent1(__VLS_68, new __VLS_68({
    ...{ 'onClick': {} },
    size: "small",
}));
const __VLS_70 = __VLS_69({
    ...{ 'onClick': {} },
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_69));
let __VLS_73;
const __VLS_74 = ({ click: {} },
    { onClick: (__VLS_ctx.handleNewChat) });
const { default: __VLS_75 } = __VLS_71.slots;
{
    const { icon: __VLS_76 } = __VLS_71.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "5",
        x2: "12",
        y2: "19",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "5",
        y1: "12",
        x2: "19",
        y2: "12",
    });
    // @ts-ignore
    [handleNewChat,];
}
(__VLS_ctx.t('chat.newChat'));
// @ts-ignore
[t,];
var __VLS_71;
var __VLS_72;
const __VLS_77 = MessageList;
// @ts-ignore
const __VLS_78 = __VLS_asFunctionalComponent1(__VLS_77, new __VLS_77({}));
const __VLS_79 = __VLS_78({}, ...__VLS_functionalComponentArgsRest(__VLS_78));
if (__VLS_ctx.contextWindow !== null) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "context-info" },
    });
    /** @type {__VLS_StyleScopedClasses['context-info']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.formatTokens(__VLS_ctx.totalTokens));
    (__VLS_ctx.formatTokens(__VLS_ctx.contextWindow));
}
const __VLS_82 = ChatInput;
// @ts-ignore
const __VLS_83 = __VLS_asFunctionalComponent1(__VLS_82, new __VLS_82({}));
const __VLS_84 = __VLS_83({}, ...__VLS_functionalComponentArgsRest(__VLS_83));
// @ts-ignore
var __VLS_42 = __VLS_41;
// @ts-ignore
[contextWindow, contextWindow, formatTokens, formatTokens, totalTokens,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
