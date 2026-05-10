<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ref, onMounted, onUnmounted } from 'vue'

const { t } = useI18n()
const router = useRouter()
const copied = ref(false)
const canvasRef = ref<HTMLCanvasElement>()

const installCmd = 'npm install -g hermes-web-ui'

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(installCmd)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {}
}

// ─── Particle network animation ──────────────────────────

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

let animId = 0
let particles: Particle[] = []

function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')!
  const dpr = window.devicePixelRatio || 1

  function resize() {
    const el = canvasRef.value
    if (!el || !el.parentElement) return
    const rect = el.parentElement.getBoundingClientRect()
    el.width = rect.width * dpr
    el.height = rect.height * dpr
    el.style.width = rect.width + 'px'
    el.style.height = rect.height + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  resize()

  const count = Math.min(60, Math.floor((canvas.width / dpr) / 18))
  const w = canvas.width / dpr
  const h = canvas.height / dpr

  particles = Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    r: Math.random() * 1.5 + 0.5,
  }))

  const maxDist = 120

  function draw() {
    const dark = document.documentElement.classList.contains('dark')
    const dotColor = dark ? 'rgba(224,224,224,' : 'rgba(51,51,51,'
    const lineColor = dark ? 'rgba(224,224,224,' : 'rgba(51,51,51,'

    ctx.clearRect(0, 0, w, h)

    // Update & draw particles
    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy
      if (p.x < 0 || p.x > w) p.vx *= -1
      if (p.y < 0 || p.y > h) p.vy *= -1

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = dotColor + '0.6)'
      ctx.fill()
    }

    // Draw connections
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x
        const dy = particles[i].y - particles[j].y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < maxDist) {
          const alpha = (1 - dist / maxDist) * 0.15
          ctx.beginPath()
          ctx.moveTo(particles[i].x, particles[i].y)
          ctx.lineTo(particles[j].x, particles[j].y)
          ctx.strokeStyle = lineColor + alpha + ')'
          ctx.lineWidth = 0.5
          ctx.stroke()
        }
      }
    }

    animId = requestAnimationFrame(draw)
  }

  draw()

  const onResize = () => {
    cancelAnimationFrame(animId)
    initCanvas()
  }
  window.addEventListener('resize', onResize)

  onUnmounted(() => {
    cancelAnimationFrame(animId)
    window.removeEventListener('resize', onResize)
  })
}

onMounted(() => {
  initCanvas()
})
</script>

<template>
  <section class="hero">
    <canvas ref="canvasRef" class="hero-canvas" />
    <div class="hero-inner">
      <h1 class="hero-title animate-fade-in-up">{{ t('hero.title') }}</h1>
      <p class="hero-subtitle animate-fade-in-up animate-delay-1">{{ t('hero.subtitle') }}</p>
      <div class="hero-actions animate-fade-in-up animate-delay-2">
        <button class="btn-primary" @click="router.push({ name: 'docs.getting-started' })">
          {{ t('hero.cta') }}
        </button>
        <a
          class="btn-outline"
          href="https://github.com/EKKOLearnAI/hermes-web-ui"
          target="_blank"
          rel="noopener"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="btn-icon">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          {{ t('hero.viewGithub') }}
        </a>
      </div>
      <div class="install-box animate-fade-in animate-delay-3">
        <code>{{ installCmd }}</code>
        <button class="copy-btn" @click="copyCmd">
          {{ copied ? 'Copied!' : 'Copy' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.hero {
  position: relative;
  overflow: hidden;
  padding: 120px 24px 80px;
  text-align: center;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);

  @media (max-width: $breakpoint-mobile) {
    padding: 80px 16px 48px;
  }
}

.hero-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.hero-inner {
  position: relative;
  z-index: 1;
  max-width: 720px;
  margin: 0 auto;
}

.hero-title {
  font-size: 48px;
  font-weight: 700;
  line-height: 1.2;
  margin-bottom: 20px;
  color: var(--text-primary);

  @media (max-width: $breakpoint-mobile) {
    font-size: 32px;
  }
}

.hero-subtitle {
  font-size: 18px;
  line-height: 1.6;
  color: var(--text-secondary);
  margin-bottom: 36px;

  @media (max-width: $breakpoint-mobile) {
    font-size: 15px;
  }
}

.hero-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-bottom: 36px;
  flex-wrap: wrap;
}

.btn-primary {
  padding: 12px 28px;
  background: var(--accent-primary);
  color: var(--text-on-accent);
  border: none;
  border-radius: $radius-md;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background $transition-fast, transform $transition-fast;

  &:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }
}

.btn-outline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  font-size: 15px;
  font-weight: 500;
  text-decoration: none;
  transition: all $transition-fast;

  &:hover {
    border-color: var(--text-muted);
    transform: translateY(-1px);
  }
}

.btn-icon {
  width: 18px;
  height: 18px;
}

.install-box {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  padding: 12px 20px;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  code {
    font-size: 14px;
    background: transparent;
    padding: 0;
    white-space: nowrap;
  }

  @media (max-width: $breakpoint-mobile) {
    padding: 10px 14px;
    gap: 8px;

    code {
      font-size: 12px;
    }
  }
}

.copy-btn {
  padding: 4px 12px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
}
</style>
