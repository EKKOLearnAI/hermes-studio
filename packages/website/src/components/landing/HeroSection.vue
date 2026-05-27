<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ref, onMounted, onUnmounted } from 'vue'

const { t } = useI18n()
const router = useRouter()
const copied = ref(false)
const canvasRef = ref<HTMLCanvasElement>()

const installCmd = 'bash scripts/deploy-source-armbian.sh'

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
