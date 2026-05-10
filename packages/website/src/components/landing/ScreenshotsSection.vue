<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useScrollReveal } from '@/composables/useScrollReveal'

useScrollReveal()

const images = [
  { src: '/image1.png', alt: 'AI Chat with Image Generation' },
  { src: '/image2.png', alt: 'Chat and File Browser' },
  { src: '/image3.png', alt: 'Multi-panel Workspace' },
  { src: '/image4.png', alt: 'Kanban Board' },
]

const activeIndex = ref(0)
let timer: ReturnType<typeof setInterval>

function next() {
  activeIndex.value = (activeIndex.value + 1) % images.length
}

function prev() {
  activeIndex.value = (activeIndex.value - 1 + images.length) % images.length
}

function setActive(i: number) {
  activeIndex.value = i
  resetTimer()
}

function resetTimer() {
  clearInterval(timer)
  timer = setInterval(next, 5000)
}

onMounted(() => {
  timer = setInterval(next, 5000)
})

onUnmounted(() => {
  clearInterval(timer)
})
</script>

<template>
  <section class="screenshots-section">
    <div class="screenshots-inner reveal">
      <!-- Browser frame mockup -->
      <div class="browser-frame">
        <div class="browser-bar">
          <div class="browser-dots">
            <span class="dot red" />
            <span class="dot yellow" />
            <span class="dot green" />
          </div>
          <div class="browser-url">
            <span>http://localhost:8648</span>
          </div>
          <div class="browser-spacer" />
        </div>
        <div class="browser-viewport">
          <transition name="slide" mode="out-in">
            <img
              :key="activeIndex"
              :src="images[activeIndex].src"
              :alt="images[activeIndex].alt"
              class="screenshot-img"
            />
          </transition>
        </div>
      </div>

      <!-- Navigation -->
      <div class="screenshot-nav">
        <button class="nav-arrow" @click="prev(); resetTimer()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6" /></svg>
        </button>

        <div class="screenshot-dots">
          <button
            v-for="(_img, i) in images"
            :key="i"
            class="dot-btn"
            :class="{ active: activeIndex === i }"
            @click="setActive(i)"
          />
        </div>

        <button class="nav-arrow" @click="next(); resetTimer()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.screenshots-section {
  padding: 0 24px;
  margin-top: 48px;
  margin-bottom: 24px;

  @media (max-width: $breakpoint-mobile) {
    padding: 0 12px;
    margin-top: 32px;
    margin-bottom: 16px;
  }
}

.screenshots-inner {
  max-width: 920px;
  margin: 0 auto;
}

// ─── Browser Frame ──────────────────────────

.browser-frame {
  border-radius: $radius-lg;
  border: 1px solid var(--border-color);
  overflow: hidden;
  background: var(--bg-secondary);
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.06),
    0 20px 60px rgba(0, 0, 0, 0.08);
  transition: transform 0.4s ease, box-shadow 0.4s ease;

  &:hover {
    transform: translateY(-4px);
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.08),
      0 32px 80px rgba(0, 0, 0, 0.12);
  }
}

.browser-bar {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  gap: 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
}

.browser-dots {
  display: flex;
  gap: 6px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;

  &.red { background: #ff5f57; }
  &.yellow { background: #febc2e; }
  &.green { background: #28c840; }
}

.browser-url {
  flex: 1;
  background: var(--bg-secondary);
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: $font-code;
  text-align: center;
}

.browser-spacer {
  width: 52px;
}

.browser-viewport {
  position: relative;
  width: 100%;
  background: var(--bg-secondary);
}

.screenshot-img {
  width: 100%;
  display: block;
}

// ─── Slide Transition ───────────────────────

.slide-enter-active,
.slide-leave-active {
  transition: all 0.4s ease;
}

.slide-enter-from {
  opacity: 0;
  transform: translateX(24px);
}

.slide-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}

// ─── Navigation ─────────────────────────────

.screenshot-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 16px;
}

.nav-arrow {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  svg {
    width: 16px;
    height: 16px;
  }
}

.screenshot-dots {
  display: flex;
  gap: 8px;
}

.dot-btn {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  background: var(--border-color);
  cursor: pointer;
  transition: all $transition-fast;

  &.active {
    background: var(--accent-primary);
    transform: scale(1.3);
  }

  &:hover:not(.active) {
    background: var(--text-muted);
  }
}
</style>
