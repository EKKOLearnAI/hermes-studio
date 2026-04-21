import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useChatStore } from '@/stores/hermes/chat';
export function useKeyboard() {
    const router = useRouter();
    const chatStore = useChatStore();
    function handleKeydown(e) {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === 'n') {
            e.preventDefault();
            chatStore.newChat();
        }
        if (mod && e.key === 'j') {
            e.preventDefault();
            router.push({ name: 'hermes.jobs' });
        }
        if (e.key === 'Escape') {
            // Close any open modals — naive-ui handles this internally
            const modal = document.querySelector('.n-modal-mask');
            if (modal) {
                const closeBtn = modal.querySelector('.n-base-close');
                closeBtn?.click();
            }
        }
    }
    onMounted(() => {
        window.addEventListener('keydown', handleKeydown);
    });
    onUnmounted(() => {
        window.removeEventListener('keydown', handleKeydown);
    });
}
