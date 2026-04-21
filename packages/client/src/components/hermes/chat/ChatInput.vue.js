/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { useChatStore } from '@/stores/hermes/chat';
import { NButton, NTooltip } from 'naive-ui';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import CommandPalette from './CommandPalette.vue';
const chatStore = useChatStore();
const { t } = useI18n();
const inputText = ref('');
const textareaRef = ref();
const fileInputRef = ref();
const attachments = ref([]);
const isDragging = ref(false);
const dragCounter = ref(0);
const isComposing = ref(false);
const showCommandPalette = ref(false);
const commandPaletteFilter = ref('');
const commandPaletteRef = ref();
const canSend = computed(() => inputText.value.trim() || attachments.value.length > 0);
// Command palette
const commands = [
    { id: 'vision', label: '/vision', description: t('chat.cmdVision') || 'Image understanding' },
    { id: 'claude', label: '/claude', description: t('chat.cmdClaude') || 'Use Claude model' },
    { id: 'gpt4', label: '/gpt4', description: t('chat.cmdGpt4') || 'Use GPT-4 model' },
    { id: 'code', label: '/code', description: t('chat.cmdCode') || 'Code mode' },
    { id: 'rewrite', label: '/rewrite', description: t('chat.cmdRewrite') || 'Rewrite selected text' },
    { id: 'summarize', label: '/summarize', description: t('chat.cmdSummarize') || 'Summarize thread' },
    { id: 'translate', label: '/translate', description: t('chat.cmdTranslate') || 'Translate to English' },
    { id: 'jobs', label: '/jobs', description: t('chat.cmdJobs') || 'Jump to scheduled jobs' },
    { id: 'terminal', label: '/terminal', description: t('chat.cmdTerminal') || 'Open terminal' },
];
const filteredCommands = computed(() => {
    if (!commandPaletteFilter.value)
        return commands;
    const q = commandPaletteFilter.value.toLowerCase();
    return commands.filter(c => c.id.includes(q) || c.label.toLowerCase().includes(q));
});
function handleCommandSelect(cmd) {
    // Remove the '/' prefix that was typed, then insert the full command
    inputText.value = inputText.value.replace(/^\/\w*$/, cmd.label + ' ');
    showCommandPalette.value = false;
    commandPaletteFilter.value = '';
    nextTick(() => textareaRef.value?.focus());
}
function handleCommandKeydown(e) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        commandPaletteRef.value?.moveDown();
    }
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        commandPaletteRef.value?.moveUp();
    }
    else if (e.key === 'Enter') {
        e.preventDefault();
        commandPaletteRef.value?.confirm();
    }
    else if (e.key === 'Escape') {
        showCommandPalette.value = false;
        commandPaletteFilter.value = '';
    }
}
function handleClickOutside(e) {
    const target = e.target;
    if (!target.closest('.command-palette-wrapper')) {
        showCommandPalette.value = false;
        commandPaletteFilter.value = '';
    }
}
onMounted(() => document.addEventListener('click', handleClickOutside));
onUnmounted(() => document.removeEventListener('click', handleClickOutside));
// --- Voice input (Web Speech API) ---
// TODO: re-enable when needed — browser-native speech-to-text
// const hasSpeechRecognition = ref(false)
// let recognition: SpeechRecognition | null = null
// let finalTranscript = ''
// let prefixText = ''
// onMounted(() => {
//   const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
//   if (!SR) return
//   recognition = new SR()
//   recognition.continuous = false
//   recognition.interimResults = true
//   recognition.lang = 'en-US'
//   hasSpeechRecognition.value = true
//   recognition.onresult = (event: SpeechRecognitionEvent) => { ... }
//   recognition.onend = () => { ... }
//   recognition.onerror = (event: SpeechRecognitionErrorEvent) => { ... }
// })
// onUnmounted(() => { if (recognition && isRecording.value) recognition.stop() })
// --- File attachment helpers ---
function addFile(file) {
    if (attachments.value.find(a => a.name === file.name))
        return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const url = URL.createObjectURL(file);
    attachments.value.push({
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        url,
        file,
    });
}
function handleAttachClick() {
    fileInputRef.value?.click();
}
function handleFileChange(e) {
    const input = e.target;
    if (!input.files)
        return;
    for (const file of input.files)
        addFile(file);
    input.value = '';
}
// --- Paste image ---
function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(i => i.type.startsWith('image/'));
    if (!imageItems.length)
        return;
    e.preventDefault();
    for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob)
            continue;
        const ext = item.type.split('/')[1] || 'png';
        const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type });
        addFile(file);
    }
}
// --- Drag and drop ---
function handleDragOver(e) {
    e.preventDefault();
}
function handleDragEnter(e) {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
        dragCounter.value++;
        isDragging.value = true;
    }
}
function handleDragLeave() {
    dragCounter.value--;
    if (dragCounter.value <= 0) {
        dragCounter.value = 0;
        isDragging.value = false;
    }
}
function handleDrop(e) {
    e.preventDefault();
    dragCounter.value = 0;
    isDragging.value = false;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length)
        return;
    for (const file of files)
        addFile(file);
    textareaRef.value?.focus();
}
// --- Input & keyboard ---
function handleInput(e) {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
    // Command palette trigger
    if (el.value === '/') {
        showCommandPalette.value = true;
        commandPaletteFilter.value = '';
    }
    else if (el.value.startsWith('/')) {
        showCommandPalette.value = true;
        commandPaletteFilter.value = el.value.slice(1);
    }
    else {
        showCommandPalette.value = false;
        commandPaletteFilter.value = '';
    }
}
function handleKeydown(e) {
    if (showCommandPalette.value) {
        handleCommandKeydown(e);
        return;
    }
    if (e.key !== 'Enter' || e.shiftKey)
        return;
    if (isImeEnter(e))
        return;
    e.preventDefault();
    handleSend();
}
function handleSend() {
    const text = inputText.value.trim();
    if (!text && attachments.value.length === 0)
        return;
    chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined);
    inputText.value = '';
    attachments.value = [];
    if (textareaRef.value) {
        textareaRef.value.style.height = 'auto';
    }
    showCommandPalette.value = false;
    commandPaletteFilter.value = '';
}
function handleCompositionStart() {
    isComposing.value = true;
}
function handleCompositionEnd() {
    requestAnimationFrame(() => {
        isComposing.value = false;
    });
}
function isImeEnter(e) {
    return isComposing.value || e.isComposing || e.keyCode === 229;
}
function handleKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey)
        return;
    if (isImeEnter(e))
        return;
    e.preventDefault();
    handleSend();
}
function handleInput(e) {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}
function removeAttachment(id) {
    const idx = attachments.value.findIndex(a => a.id === id);
    if (idx !== -1) {
        URL.revokeObjectURL(attachments.value[idx].url);
        attachments.value.splice(idx, 1);
    }
}
function formatSize(bytes) {
    if (bytes < 1024)
        return bytes + ' B';
    if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function isImage(type) {
    return type.startsWith('image/');
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['attachment-preview']} */ ;
/** @type {__VLS_StyleScopedClasses['input-wrapper']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-input-area" },
});
/** @type {__VLS_StyleScopedClasses['chat-input-area']} */ ;
if (__VLS_ctx.attachments.length > 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "attachment-previews" },
    });
    /** @type {__VLS_StyleScopedClasses['attachment-previews']} */ ;
    for (const [att] of __VLS_vFor((__VLS_ctx.attachments))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (att.id),
            ...{ class: "attachment-preview" },
            ...{ class: ({ image: __VLS_ctx.isImage(att.type) }) },
        });
        /** @type {__VLS_StyleScopedClasses['attachment-preview']} */ ;
        /** @type {__VLS_StyleScopedClasses['image']} */ ;
        if (__VLS_ctx.isImage(att.type)) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
                src: (att.url),
                alt: (att.name),
                ...{ class: "attachment-thumb" },
            });
            /** @type {__VLS_StyleScopedClasses['attachment-thumb']} */ ;
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "attachment-file" },
            });
            /** @type {__VLS_StyleScopedClasses['attachment-file']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                width: "20",
                height: "20",
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
                ...{ class: "file-name" },
            });
            /** @type {__VLS_StyleScopedClasses['file-name']} */ ;
            (att.name);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "file-size" },
            });
            /** @type {__VLS_StyleScopedClasses['file-size']} */ ;
            (__VLS_ctx.formatSize(att.size));
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.attachments.length > 0))
                        return;
                    __VLS_ctx.removeAttachment(att.id);
                    // @ts-ignore
                    [attachments, attachments, isImage, isImage, formatSize, removeAttachment,];
                } },
            ...{ class: "attachment-remove" },
        });
        /** @type {__VLS_StyleScopedClasses['attachment-remove']} */ ;
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
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onDragover: (__VLS_ctx.handleDragOver) },
    ...{ onDragenter: (__VLS_ctx.handleDragEnter) },
    ...{ onDragleave: (__VLS_ctx.handleDragLeave) },
    ...{ onDrop: (__VLS_ctx.handleDrop) },
    ...{ class: "input-wrapper" },
    ...{ class: ({ 'drag-over': __VLS_ctx.isDragging }) },
});
/** @type {__VLS_StyleScopedClasses['input-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['drag-over']} */ ;
if (__VLS_ctx.showCommandPalette) {
    const __VLS_0 = CommandPalette;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        ...{ 'onSelect': {} },
        ref: "commandPaletteRef",
        commands: (__VLS_ctx.filteredCommands),
        ...{ class: "command-palette-wrapper" },
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onSelect': {} },
        ref: "commandPaletteRef",
        commands: (__VLS_ctx.filteredCommands),
        ...{ class: "command-palette-wrapper" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_5;
    const __VLS_6 = ({ select: {} },
        { onSelect: (__VLS_ctx.handleCommandSelect) });
    var __VLS_7 = {};
    /** @type {__VLS_StyleScopedClasses['command-palette-wrapper']} */ ;
    var __VLS_3;
    var __VLS_4;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ onChange: (__VLS_ctx.handleFileChange) },
    ref: "fileInputRef",
    type: "file",
    multiple: true,
    ...{ class: "file-input-hidden" },
});
/** @type {__VLS_StyleScopedClasses['file-input-hidden']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    ...{ onCompositionstart: (__VLS_ctx.handleCompositionStart) },
    ...{ onCompositionend: (__VLS_ctx.handleCompositionEnd) },
    ...{ onInput: (__VLS_ctx.handleInput) },
    ...{ onPaste: (__VLS_ctx.handlePaste) },
    ref: "textareaRef",
    value: (__VLS_ctx.inputText),
    ...{ class: "input-textarea" },
    placeholder: (__VLS_ctx.t('chat.inputPlaceholder')),
    rows: "1",
});
/** @type {__VLS_StyleScopedClasses['input-textarea']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "input-actions" },
});
/** @type {__VLS_StyleScopedClasses['input-actions']} */ ;
let __VLS_9;
/** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
NTooltip;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent1(__VLS_9, new __VLS_9({
    trigger: "hover",
}));
const __VLS_11 = __VLS_10({
    trigger: "hover",
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
const { default: __VLS_14 } = __VLS_12.slots;
{
    const { trigger: __VLS_15 } = __VLS_12.slots;
    let __VLS_16;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent1(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "small",
        circle: true,
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "small",
        circle: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_21;
    const __VLS_22 = ({ click: {} },
        { onClick: (__VLS_ctx.handleAttachClick) });
    const { default: __VLS_23 } = __VLS_19.slots;
    {
        const { icon: __VLS_24 } = __VLS_19.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
            d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
        });
        // @ts-ignore
        [handleDragOver, handleDragEnter, handleDragLeave, handleDrop, isDragging, showCommandPalette, filteredCommands, handleCommandSelect, handleFileChange, handleKeydown, handleCompositionStart, handleCompositionEnd, handleInput, handlePaste, inputText, t, handleAttachClick,];
    }
    // @ts-ignore
    [];
    var __VLS_19;
    var __VLS_20;
    // @ts-ignore
    [];
}
(__VLS_ctx.t('chat.attachFiles'));
// @ts-ignore
[t,];
var __VLS_12;
if (__VLS_ctx.chatStore.isStreaming) {
    let __VLS_25;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({
        ...{ 'onClick': {} },
        size: "small",
        type: "error",
    }));
    const __VLS_27 = __VLS_26({
        ...{ 'onClick': {} },
        size: "small",
        type: "error",
    }, ...__VLS_functionalComponentArgsRest(__VLS_26));
    let __VLS_30;
    const __VLS_31 = ({ click: {} },
        { onClick: (...[$event]) => {
                if (!(__VLS_ctx.chatStore.isStreaming))
                    return;
                __VLS_ctx.chatStore.stopStreaming();
                // @ts-ignore
                [chatStore, chatStore,];
            } });
    const { default: __VLS_32 } = __VLS_28.slots;
    (__VLS_ctx.t('chat.stop'));
    // @ts-ignore
    [t,];
    var __VLS_28;
    var __VLS_29;
}
let __VLS_33;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.canSend || __VLS_ctx.chatStore.isStreaming),
}));
const __VLS_35 = __VLS_34({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    disabled: (!__VLS_ctx.canSend || __VLS_ctx.chatStore.isStreaming),
}, ...__VLS_functionalComponentArgsRest(__VLS_34));
let __VLS_38;
const __VLS_39 = ({ click: {} },
    { onClick: (__VLS_ctx.handleSend) });
const { default: __VLS_40 } = __VLS_36.slots;
{
    const { icon: __VLS_41 } = __VLS_36.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "22",
        y1: "2",
        x2: "11",
        y2: "13",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.polygon)({
        points: "22 2 15 22 11 13 2 9 22 2",
    });
    // @ts-ignore
    [chatStore, canSend, handleSend,];
}
(__VLS_ctx.t('chat.send'));
// @ts-ignore
[t,];
var __VLS_36;
var __VLS_37;
// @ts-ignore
var __VLS_8 = __VLS_7;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
