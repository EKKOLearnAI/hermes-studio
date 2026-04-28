<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'
import type { AgentMood } from '@/stores/hermes/chat'
import thinkingVideoLight from '@/assets/thinking-light.mp4'
import thinkingVideoDark from '@/assets/thinking-dark.mp4'

const props = defineProps<{ mood: AgentMood }>()

const { isDark } = useTheme()

const thinkingSrc = computed(() => (isDark.value ? thinkingVideoDark : thinkingVideoLight))

const moodEmoji: Record<Exclude<AgentMood, 'idle' | 'thinking'>, string> = {
  success: '✅',
  failed: '❌',
  happy: '😊',
  curious: '🤔',
  excited: '🎉',
  sad: '😢',
}
</script>

<template>
  <Transition name="mood" mode="out-in">
    <video
      v-if="mood === 'thinking'"
      key="thinking"
      :src="thinkingSrc"
      width="120"
      height="213"
      autoplay
      loop
      muted
      playsinline
      class="mood-video"
    />
    <span
      v-else-if="mood !== 'idle'"
      :key="mood"
      class="mood-emoji"
      :class="`anim-${mood}`"
    >{{ moodEmoji[mood as keyof typeof moodEmoji] }}</span>
  </Transition>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mood-video {
  flex-shrink: 0;
  border-radius: $radius-md;
  object-fit: contain;
}

.mood-emoji {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 88px;
  line-height: 1;
  width: 120px;
  height: 213px;
  flex-shrink: 0;
  border-radius: $radius-md;
  background: rgba(0, 0, 0, 0.03);
  user-select: none;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }
}

// ── Mood animations ────────────────────────────────────────────

.anim-success {
  animation: scale-glow 1.2s ease-in-out infinite;
}

.anim-failed {
  animation: shake 0.6s ease-in-out infinite;
}

.anim-happy {
  animation: gentle-bounce 1.6s ease-in-out infinite;
}

.anim-curious {
  animation: tilt-rock 2s ease-in-out infinite;
}

.anim-excited {
  animation: rapid-bounce 0.6s ease-in-out infinite;
}

.anim-sad {
  animation: slow-drop 2s ease-in-out infinite;
}

// ── Keyframes ──────────────────────────────────────────────────

@keyframes scale-glow {
  0%, 100% {
    transform: scale(1);
    filter: drop-shadow(0 0 0px transparent);
  }
  50% {
    transform: scale(1.12);
    filter: drop-shadow(0 0 12px rgba(var(--success-rgb), 0.5));
  }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px) rotate(-2deg); }
  40% { transform: translateX(6px) rotate(2deg); }
  60% { transform: translateX(-4px) rotate(-1deg); }
  80% { transform: translateX(4px) rotate(1deg); }
}

@keyframes gentle-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
}

@keyframes tilt-rock {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(10deg); }
  75% { transform: rotate(-10deg); }
}

@keyframes rapid-bounce {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-14px) scale(1.08); }
}

@keyframes slow-drop {
  0% { transform: translateY(0); opacity: 1; }
  60% { transform: translateY(10px); opacity: 0.5; }
  100% { transform: translateY(0); opacity: 1; }
}

// ── Transition between moods ───────────────────────────────────

.mood-enter-active,
.mood-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.mood-enter-from {
  opacity: 0;
  transform: scale(0.7);
}

.mood-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
</style>
