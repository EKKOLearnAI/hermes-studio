/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { onMounted } from 'vue';
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue';
import { useAppStore } from '@/stores/hermes/app';
import { useChatStore } from '@/stores/hermes/chat';
import { useProfilesStore } from '@/stores/hermes/profiles';
const appStore = useAppStore();
const chatStore = useChatStore();
const profilesStore = useProfilesStore();
onMounted(async () => {
    appStore.loadModels();
    // 先加载 profile，确保缓存 key 使用正确的 profile name
    await profilesStore.fetchProfiles();
    chatStore.loadSessions();
});
const __VLS_ctx = {};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-view" },
});
/** @type {__VLS_StyleScopedClasses['chat-view']} */ ;
const __VLS_0 = ChatPanel;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
