<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  initialPrompt?: string
  source?: string
}>(), {
  initialPrompt: '',
  source: 'aurora-omnibar',
})

const copied = ref(false)

const briefText = computed(() => props.initialPrompt.trim() || [
  '請製作一支 9:16 直式短影片，時長 12 秒。',
  '請描述主角、場景、劇情、字幕、音效與避免事項。',
].join('\n'))

const duration = computed(() => {
  const match = briefText.value.match(/(?:時長|長度|duration)\s*(?:為|:|：)?\s*(\d{1,3})\s*(?:秒|s|sec|seconds?)/i)
    || briefText.value.match(/(\d{1,3})\s*(?:秒|s|sec|seconds?)/i)
  return match?.[1] ? `${match[1]} 秒` : '待確認'
})

const aspectRatio = computed(() => {
  const match = briefText.value.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  return match ? `${match[1]}:${match[2]}` : '9:16'
})

const styleLine = computed(() => {
  const match = briefText.value.match(/風格[：:]\s*([^\n]+)/)
  return match?.[1]?.trim() || '可愛寫實、電影感、明亮色彩、社群短視頻節奏'
})

const characters = computed(() => {
  const source = briefText.value.match(/主角[：:]\s*([\s\S]*?)(?:\n\s*場景[：:]|\n\s*剧情[：:]|\n\s*劇情[：:]|$)/)?.[1] || ''
  const lines = source
    .split(/\n+/)
    .map(line => line.replace(/^\s*\d+[.)、．]\s*/, '').trim())
    .filter(Boolean)
  return lines.length ? lines : ['主角設定會由 Hermes 依提示詞抽取。']
})

const scene = computed(() => {
  const match = briefText.value.match(/場景[：:]\s*([\s\S]*?)(?:\n\s*劇情[：:]|\n\s*剧情[：:]|\n\s*字幕[：:]|$)/)
  return match?.[1]?.trim() || '依照提示詞建立單一主要場景。'
})

const beats = computed(() => {
  const matches = [...briefText.value.matchAll(/第\s*(\d{1,2})\s*[-－~～]\s*(\d{1,2})\s*秒[：:]\s*([^\n]+)/g)]
  if (matches.length) {
    return matches.map(match => ({
      time: `${match[1]}-${match[2]} 秒`,
      text: match[3].trim(),
    }))
  }
  return [
    { time: '1-3 秒', text: '建立主角與場景，快速交代衝突。' },
    { time: '4-6 秒', text: '加入反應鏡頭與笑點鋪陳。' },
    { time: '7-9 秒', text: '推進到最誇張的動作高潮。' },
    { time: '10-12 秒', text: '反轉結局與最後一句 punchline。' },
  ]
})

const captions = computed(() => {
  const source = briefText.value.match(/字幕[：:]\s*([\s\S]*?)(?:\n\s*音效[：:]|\n\s*避免[：:]|$)/)?.[1] || ''
  const quoted = [...source.matchAll(/[「“"]([^」”"]+)[」”"]/g)].map(match => match[1].trim())
  if (quoted.length) return quoted
  return source
    .split(/\n+/)
    .map(line => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean)
})

const soundDesign = computed(() => {
  const match = briefText.value.match(/音效[：:]\s*([\s\S]*?)(?:\n\s*避免[：:]|$)/)
  return match?.[1]?.trim() || '加入節奏音效、反應音效與結尾短暫停頓。'
})

const avoidList = computed(() => {
  const source = briefText.value.match(/避免[：:]\s*([\s\S]*)$/)?.[1] || ''
  const parts = source
    .split(/[，,、\n]+/)
    .map(item => item.trim().replace(/[。.]$/, ''))
    .filter(Boolean)
  return parts.length ? parts : ['避免恐怖風格', '避免角色變形', '避免文字亂碼']
})

const productionPrompt = computed(() => {
  return [
    `Format: vertical ${aspectRatio.value}, ${duration.value}, social short video.`,
    `Visual style: ${styleLine.value}.`,
    `Scene: ${scene.value}`,
    `Characters: ${characters.value.join(' / ')}`,
    'Timeline:',
    ...beats.value.map(beat => `- ${beat.time}: ${beat.text}`),
    captions.value.length ? `Captions: ${captions.value.join(' / ')}` : 'Captions: use concise Traditional Chinese captions.',
    `Sound design: ${soundDesign.value}`,
    `Avoid: ${avoidList.value.join(' / ')}`,
    'Keep all text legible, no humans, no extra characters, no horror tone, no malformed anatomy.',
  ].join('\n')
})

async function copyPrompt() {
  await navigator.clipboard?.writeText(productionPrompt.value)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1800)
}
</script>

<template>
  <section class="video-studio-app" aria-label="Aurora Video Studio">
    <header class="video-hero">
      <div>
        <p>Creative Render Desk</p>
        <h1>Aurora Video Studio</h1>
        <span>影片需求已固定在 Aurora 內部處理，不會跳出 App。</span>
      </div>
      <div class="video-meta-grid">
        <article>
          <span>Ratio</span>
          <strong>{{ aspectRatio }}</strong>
        </article>
        <article>
          <span>Length</span>
          <strong>{{ duration }}</strong>
        </article>
        <article>
          <span>Mode</span>
          <strong>Storyboard</strong>
        </article>
      </div>
    </header>

    <div class="video-layout">
      <section class="glass-panel brief-panel">
        <div class="panel-title">
          <span>Input Brief</span>
          <small>{{ source }}</small>
        </div>
        <pre>{{ briefText }}</pre>
      </section>

      <section class="glass-panel">
        <div class="panel-title">
          <span>Production Board</span>
          <small>秒數分鏡</small>
        </div>
        <div class="beat-list">
          <article v-for="beat in beats" :key="beat.time" class="beat-card">
            <strong>{{ beat.time }}</strong>
            <p>{{ beat.text }}</p>
          </article>
        </div>
      </section>

      <section class="glass-panel">
        <div class="panel-title">
          <span>Characters</span>
          <small>主角設定</small>
        </div>
        <ul class="clean-list">
          <li v-for="character in characters" :key="character">{{ character }}</li>
        </ul>
      </section>

      <section class="glass-panel">
        <div class="panel-title">
          <span>Captions & Sound</span>
          <small>字幕與音效</small>
        </div>
        <div class="caption-row">
          <span v-for="caption in captions" :key="caption">{{ caption }}</span>
        </div>
        <p class="sound-copy">{{ soundDesign }}</p>
      </section>

      <section class="glass-panel prompt-panel">
        <div class="panel-title">
          <span>Generator Prompt</span>
          <button type="button" @click="copyPrompt">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <pre>{{ productionPrompt }}</pre>
      </section>

      <section class="glass-panel safety-panel">
        <div class="panel-title">
          <span>Guardrails</span>
          <small>避免事項</small>
        </div>
        <ul class="clean-list compact">
          <li v-for="item in avoidList" :key="item">{{ item }}</li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
.video-studio-app {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 18px;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 24px;
  color: rgba(248, 250, 252, 0.94);
  background:
    radial-gradient(680px 420px at 12% 10%, rgba(96, 165, 250, 0.18), transparent 68%),
    radial-gradient(720px 420px at 88% 16%, rgba(168, 85, 247, 0.2), transparent 68%),
    linear-gradient(135deg, rgba(2, 6, 23, 0.94), rgba(15, 23, 42, 0.9));
}

.video-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 24px 70px rgba(2, 6, 23, 0.28);
  backdrop-filter: blur(28px);
}

.video-hero p,
.panel-title span {
  margin: 0;
  color: rgba(165, 180, 252, 0.92);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.video-hero h1 {
  margin: 4px 0;
  font-size: clamp(1.8rem, 3vw, 3rem);
  line-height: 1;
}

.video-hero span,
.panel-title small,
.sound-copy {
  color: rgba(203, 213, 225, 0.78);
}

.video-meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(92px, 1fr));
  gap: 10px;
}

.video-meta-grid article {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.06);
}

.video-meta-grid span {
  display: block;
  color: rgba(148, 163, 184, 0.84);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.video-meta-grid strong {
  display: block;
  margin-top: 4px;
  color: rgba(255, 255, 255, 0.96);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 1rem;
}

.video-layout {
  display: grid;
  grid-template-columns: minmax(280px, 0.95fr) minmax(320px, 1.2fr) minmax(280px, 0.95fr);
  grid-auto-rows: minmax(140px, auto);
  gap: 14px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.glass-panel {
  min-width: 0;
  min-height: 0;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.055);
  box-shadow: 0 18px 60px rgba(2, 6, 23, 0.2);
  backdrop-filter: blur(24px);
}

.brief-panel,
.prompt-panel {
  grid-row: span 2;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.panel-title button {
  border: 1px solid rgba(129, 140, 248, 0.48);
  border-radius: 999px;
  padding: 7px 14px;
  color: rgba(199, 210, 254, 0.95);
  background: rgba(99, 102, 241, 0.18);
  font-weight: 800;
  cursor: pointer;
}

pre {
  max-height: 100%;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgba(226, 232, 240, 0.88);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.84rem;
  line-height: 1.65;
}

.beat-list {
  display: grid;
  gap: 10px;
}

.beat-card {
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.28);
}

.beat-card strong {
  display: block;
  margin-bottom: 6px;
  color: rgba(103, 232, 249, 0.92);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.beat-card p,
.clean-list,
.sound-copy {
  margin: 0;
  color: rgba(226, 232, 240, 0.84);
  line-height: 1.6;
}

.clean-list {
  display: grid;
  gap: 10px;
  padding: 0;
  list-style: none;
}

.clean-list li {
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
}

.clean-list.compact {
  gap: 8px;
}

.caption-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.caption-row span {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 8px 11px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.06);
  font-size: 0.82rem;
  font-weight: 800;
}

.safety-panel {
  border-color: rgba(251, 191, 36, 0.18);
}

@media (max-width: 1100px) {
  .video-studio-app {
    padding: 16px;
  }

  .video-hero {
    align-items: flex-start;
    flex-direction: column;
  }

  .video-meta-grid,
  .video-layout {
    grid-template-columns: 1fr;
    width: 100%;
  }

  .brief-panel,
  .prompt-panel {
    grid-row: auto;
  }
}
</style>
