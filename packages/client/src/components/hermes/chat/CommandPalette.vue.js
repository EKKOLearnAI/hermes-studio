/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { NDropdown } from 'naive-ui';
import { computed, watch, ref } from 'vue';
const props = defineProps();
const emit = defineEmits();
const commands = [
    { id: 'claude', label: '/claude', description: 'Switch to Claude model', icon: '🤖' },
    { id: 'gpt', label: '/gpt', description: 'Switch to GPT model', icon: '🤖' },
    { id: 'vision', label: '/vision', description: 'Enable vision (image analysis)', icon: '👁️' },
    { id: 'reason', label: '/reason', description: 'Enable extended thinking', icon: '🧠' },
    { id: 'search', label: '/search', description: 'Search memory and knowledge', icon: '🔍' },
    { id: 'skill', label: '/skill', description: 'Run a specific skill', icon: '⚡' },
    { id: 'new', label: '/new', description: 'Start a new conversation', icon: '✨' },
    { id: 'cancel', label: '/cancel', description: 'Cancel current response', icon: '🛑' },
    { id: 'help', label: '/help', description: 'Show available commands', icon: '❓' },
];
const filtered = computed(() => {
    if (!props.query)
        return commands;
    const q = props.query.toLowerCase();
    return commands.filter(cmd => cmd.id.includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description?.toLowerCase().includes(q));
});
watch(() => props.show, (v) => {
    if (!v)
        activeIndex.value = 0;
});
const activeIndex = ref(0);
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
if (__VLS_ctx.filtered.length > 0) {
    let __VLS_0;
    /** @ts-ignore @type {typeof __VLS_components.NDropdown} */
    NDropdown;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        ...{ 'onSelect': {} },
        placement: "bottom-start",
        trigger: "manual",
        x: (__VLS_ctx.position.x),
        y: (__VLS_ctx.position.y),
        options: (__VLS_ctx.filtered.map((cmd) => ({
            key: cmd.id,
            label: `${cmd.icon ? cmd.icon + ' ' : ''}${cmd.label}`,
        }))),
        show: (__VLS_ctx.show),
        ...{ style: ({ maxHeight: '280px', overflow: 'auto', minWidth: '200px' }) },
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onSelect': {} },
        placement: "bottom-start",
        trigger: "manual",
        x: (__VLS_ctx.position.x),
        y: (__VLS_ctx.position.y),
        options: (__VLS_ctx.filtered.map((cmd) => ({
            key: cmd.id,
            label: `${cmd.icon ? cmd.icon + ' ' : ''}${cmd.label}`,
        }))),
        show: (__VLS_ctx.show),
        ...{ style: ({ maxHeight: '280px', overflow: 'auto', minWidth: '200px' }) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_5;
    const __VLS_6 = ({ select: {} },
        { onSelect: ((key) => { __VLS_ctx.emit('select', __VLS_ctx.commands.find(c => c.id === key).label); __VLS_ctx.emit('close'); }) });
    var __VLS_7 = {};
    var __VLS_3;
    var __VLS_4;
}
// @ts-ignore
[filtered, filtered, position, position, show, emit, emit, commands,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
