<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  ANATOMY_REGION_DEFINITIONS,
  getAnatomyRegionDefinition,
} from './body-3d-model-mapping'
import {
  getBodyRegionStatusTone,
  getBodyRegionSummary,
  getCompensationChainRegions,
  getRelatedWorkoutSummary,
  getVisiblePostureIssueOverlays,
  type BodyRegionId,
  type HealthBodyMap,
  type HealthPostureProfile,
  type HealthWorkoutLike,
} from './body-visualization'
import ProfessionalAnatomyViewer from './ProfessionalAnatomyViewer.vue'

const props = withDefaults(defineProps<{
  bodyMap?: HealthBodyMap
  selectedRegion?: BodyRegionId
  workouts?: HealthWorkoutLike[]
  postureProfile?: HealthPostureProfile | null
}>(), {
  bodyMap: () => ({}),
  selectedRegion: 'chest',
  workouts: () => [],
  postureProfile: null,
})

const emit = defineEmits<{
  'update:selectedRegion': [regionId: BodyRegionId]
  'select-region': [regionId: BodyRegionId]
}>()

const activeRegion = ref<BodyRegionId>(props.selectedRegion)

watch(
  () => props.selectedRegion,
  value => {
    activeRegion.value = value
  },
)

const regionSummaries = computed(() =>
  ANATOMY_REGION_DEFINITIONS.map(region => ({
    anatomy: region,
    summary: getBodyRegionSummary(region.regionId, props.bodyMap),
    tone: getBodyRegionStatusTone(region.regionId, props.bodyMap),
  })),
)

const selectedAnatomy = computed(() => getAnatomyRegionDefinition(activeRegion.value))
const selectedSummary = computed(() => getBodyRegionSummary(activeRegion.value, props.bodyMap))
const selectedTone = computed(() => getBodyRegionStatusTone(activeRegion.value, props.bodyMap))
const professionalAssets = computed(() => {
  const seen = new Set<string>()
  return ANATOMY_REGION_DEFINITIONS
    .flatMap(region => region.assets)
    .filter(asset => {
      if (seen.has(asset.file)) return false
      seen.add(asset.file)
      return true
    })
})
const selectedAssetFiles = computed(() => selectedAnatomy.value.assets.map(asset => asset.file))
const relatedWorkout = computed(() => getRelatedWorkoutSummary(activeRegion.value, props.workouts))
const postureOverlays = computed(() =>
  getVisiblePostureIssueOverlays(props.postureProfile)
    .filter(overlay => overlay.regionIds.includes(activeRegion.value)),
)
const compensationRegions = computed(() => new Set(getCompensationChainRegions(props.postureProfile?.compensation_chain ?? [])))

function selectRegion(regionId: BodyRegionId) {
  activeRegion.value = regionId
  emit('update:selectedRegion', regionId)
  emit('select-region', regionId)
}

function assetName(file: string): string {
  return file.split('/').pop() || file
}

function formatLevel(value: number | null): string {
  return value === null ? '未记录' : String(value)
}

function priorityLabel(priority: string | null): string {
  if (priority === 'high') return '高优先级'
  if (priority === 'medium') return '中优先级'
  if (priority === 'low') return '低优先级'
  return '未设优先级'
}

function toneLabel(tone: string): string {
  if (tone === 'high') return '需重点处理'
  if (tone === 'medium') return '需要维护'
  if (tone === 'good') return '状态良好'
  return '暂无数据'
}
</script>

<template>
  <section class="health-body-viewer" aria-label="Body3D">
    <div class="viewer-main">
      <div class="viewer-header">
        <div>
          <p class="eyebrow">Body3D</p>
          <h3>身体数字孪生</h3>
          <span class="scan-status">全身扫描</span>
        </div>
        <div class="asset-count">{{ selectedAnatomy.assets.length }} STL</div>
      </div>

      <div class="digital-twin-stage">
        <div class="twin-scan" data-test="digital-twin-human" aria-label="Full body digital twin">
          <ProfessionalAnatomyViewer
            :assets="professionalAssets"
            :highlighted-assets="selectedAssetFiles"
            :label="selectedAnatomy.label"
            :tone="selectedTone"
          />
          <div class="scan-line" aria-hidden="true"></div>
          <svg class="human-silhouette" viewBox="0 0 260 620" role="img" aria-label="人体数字孪生">
            <defs>
              <linearGradient id="twinBodyFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#dbeafe" />
                <stop offset="0.48" stop-color="#bfdbfe" />
                <stop offset="1" stop-color="#a7f3d0" />
              </linearGradient>
            </defs>
            <circle class="body-part head" cx="130" cy="54" r="36" />
            <path class="body-part torso" d="M91 104 C106 92 154 92 169 104 C184 135 188 214 171 278 C159 322 101 322 89 278 C72 214 76 135 91 104Z" />
            <path class="body-part arm left-arm" d="M83 120 C54 153 39 205 36 273 C35 297 51 302 59 280 C68 228 80 181 101 143Z" />
            <path class="body-part arm right-arm" d="M177 120 C206 153 221 205 224 273 C225 297 209 302 201 280 C192 228 180 181 159 143Z" />
            <path class="body-part hips" d="M94 311 C112 331 148 331 166 311 C174 342 166 372 151 389 C139 401 121 401 109 389 C94 372 86 342 94 311Z" />
            <path class="body-part leg left-leg" d="M111 386 C96 431 87 499 82 574 C80 598 105 602 111 578 C121 521 132 457 134 392Z" />
            <path class="body-part leg right-leg" d="M149 386 C164 431 173 499 178 574 C180 598 155 602 149 578 C139 521 128 457 126 392Z" />
            <path class="body-core" d="M105 146 C119 136 141 136 155 146 C164 184 164 241 153 275 C143 290 117 290 107 275 C96 241 96 184 105 146Z" />
          </svg>

          <button
            v-for="region in regionSummaries"
            :key="region.anatomy.regionId"
            type="button"
            class="body-region"
            :class="[
              `region-${region.anatomy.regionId}`,
              `tone-${region.tone}`,
              { active: activeRegion === region.anatomy.regionId, chain: compensationRegions.has(region.anatomy.regionId) },
            ]"
            :data-test="`body-region-${region.anatomy.regionId}`"
            :aria-label="`${region.anatomy.label} ${toneLabel(region.tone)}`"
            @click="selectRegion(region.anatomy.regionId)"
          >
            <span class="region-dot"></span>
            <span class="region-label" :data-test="`twin-region-${region.anatomy.regionId}`">{{ region.anatomy.label }}</span>
            <small>{{ toneLabel(region.tone) }}</small>
          </button>
        </div>

        <div class="vital-strip" data-test="twin-vital-strip">
          <div>
            <span>发达度</span>
            <strong>{{ formatLevel(selectedSummary.developmentLevel) }}</strong>
          </div>
          <div>
            <span>激活度</span>
            <strong>{{ formatLevel(selectedSummary.activationLevel) }}</strong>
          </div>
          <div>
            <span>体态限制</span>
            <strong>{{ formatLevel(selectedSummary.postureConstraintLevel) }}</strong>
          </div>
          <div>
            <span>优先级</span>
            <strong>{{ priorityLabel(selectedSummary.priority) }}</strong>
          </div>
        </div>
      </div>
    </div>

    <aside class="viewer-details" data-test="selected-region">
      <div class="detail-heading">
        <div>
          <p class="eyebrow">当前区域</p>
          <h4>{{ selectedAnatomy.label }}</h4>
        </div>
        <span class="tone-pill" :class="`tone-${selectedTone}`">{{ toneLabel(selectedTone) }}</span>
      </div>

      <dl class="metric-grid">
        <div>
          <dt>发达度</dt>
          <dd>{{ formatLevel(selectedSummary.developmentLevel) }}</dd>
        </div>
        <div>
          <dt>激活度</dt>
          <dd>{{ formatLevel(selectedSummary.activationLevel) }}</dd>
        </div>
        <div>
          <dt>体态限制</dt>
          <dd>{{ formatLevel(selectedSummary.postureConstraintLevel) }}</dd>
        </div>
        <div>
          <dt>优先级</dt>
          <dd>{{ priorityLabel(selectedSummary.priority) }}</dd>
        </div>
      </dl>

      <div class="detail-section">
        <h5>模型资产</h5>
        <div class="asset-list">
          <span v-for="asset in selectedAnatomy.assets" :key="asset.file">
            {{ assetName(asset.file) }}
          </span>
        </div>
      </div>

      <div class="detail-section">
        <h5>关联训练</h5>
        <p v-if="relatedWorkout" class="muted">
          {{ relatedWorkout.title }} · {{ relatedWorkout.durationMinutes ?? '未知' }} 分钟 · {{ relatedWorkout.intensity ?? '未记录强度' }}
        </p>
        <p v-else class="muted">暂无直接匹配训练记录</p>
      </div>

      <div class="detail-section">
        <h5>体态叠加</h5>
        <div v-if="postureOverlays.length" class="overlay-list">
          <span v-for="overlay in postureOverlays" :key="overlay.id">
            {{ overlay.label }}
          </span>
        </div>
        <p v-else class="muted">当前区域暂无体态叠加问题</p>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.health-body-viewer {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

.viewer-main,
.viewer-details {
  border: 1px solid var(--border-color, #d7dde8);
  border-radius: 8px;
  background: var(--card-color, #fff);
}

.viewer-main {
  min-height: 620px;
  padding: 18px;
  overflow: hidden;
}

.viewer-details {
  padding: 18px;
}

.viewer-header,
.detail-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 4px;
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
}

h3,
h4,
h5 {
  margin: 0;
}

.asset-count,
.tone-pill,
.scan-status {
  flex: none;
  border-radius: 999px;
  padding: 4px 9px;
  background: #f1f5f9;
  color: #334155;
  font-size: 12px;
  font-weight: 650;
}

.scan-status {
  display: inline-flex;
  margin-top: 8px;
  background: rgba(14, 165, 233, 0.12);
  color: #0369a1;
}

.digital-twin-stage {
  position: relative;
  display: grid;
  grid-template-columns: minmax(260px, 1fr);
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  min-height: 530px;
}

.digital-twin-stage::before,
.digital-twin-stage::after {
  position: absolute;
  inset: 20px 18%;
  content: '';
  pointer-events: none;
}

.digital-twin-stage::before {
  border: 1px solid rgba(14, 165, 233, 0.18);
  border-radius: 999px;
}

.digital-twin-stage::after {
  border-top: 1px solid rgba(34, 197, 94, 0.22);
  border-bottom: 1px solid rgba(34, 197, 94, 0.22);
}

.twin-scan {
  position: relative;
  z-index: 1;
  width: min(100%, 620px);
  min-height: 500px;
  margin: 0 auto;
  border: 1px solid rgba(37, 99, 235, 0.16);
  border-radius: 8px;
  background:
    linear-gradient(90deg, rgba(14, 165, 233, 0.08) 1px, transparent 1px),
    linear-gradient(0deg, rgba(14, 165, 233, 0.08) 1px, transparent 1px),
    radial-gradient(circle at 50% 45%, rgba(59, 130, 246, 0.18), transparent 56%),
    #f8fafc;
  background-size: 28px 28px, 28px 28px, auto, auto;
  box-shadow: inset 0 0 42px rgba(37, 99, 235, 0.1);
  overflow: hidden;
}

.vital-strip {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  width: min(100%, 620px);
  margin: 0 auto;
}

.vital-strip div {
  border: 1px solid rgba(148, 163, 184, 0.34);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.94), rgba(241, 245, 249, 0.78));
  padding: 10px;
}

.vital-strip span,
.vital-strip strong {
  display: block;
}

.vital-strip span {
  color: #64748b;
  font-size: 12px;
}

.vital-strip strong {
  margin-top: 4px;
  color: #0f172a;
  font-size: 15px;
}

.scan-line {
  position: absolute;
  left: 12%;
  right: 12%;
  top: 18%;
  z-index: 3;
  height: 2px;
  background: rgba(16, 185, 129, 0.78);
  box-shadow: 0 0 18px rgba(16, 185, 129, 0.7);
  animation: scan-pass 4.8s linear infinite;
  pointer-events: none;
}

.human-silhouette {
  position: absolute;
  inset: 14px 76px 14px;
  z-index: 0;
  width: calc(100% - 152px);
  height: calc(100% - 28px);
  opacity: 0.06;
  filter: drop-shadow(0 18px 28px rgba(15, 23, 42, 0.16));
  pointer-events: none;
}

.body-part,
.body-core {
  fill: url(#twinBodyFill);
  stroke: rgba(37, 99, 235, 0.46);
  stroke-width: 3;
}

.body-core {
  fill: rgba(255, 255, 255, 0.34);
  stroke: rgba(14, 165, 233, 0.36);
}

.body-region {
  position: absolute;
  z-index: 4;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  border: 1px solid rgba(15, 23, 42, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: #0f172a;
  text-align: center;
  padding: 0;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.13);
  backdrop-filter: blur(6px);
}

.region-chest {
  left: 50%;
  top: 25%;
  transform: translateX(-50%);
}

.region-shoulders {
  left: 14%;
  top: 22%;
}

.region-biceps {
  right: 10%;
  top: 31%;
}

.region-forearms {
  left: 7%;
  top: 48%;
}

.region-abs {
  left: 50%;
  top: 43%;
  transform: translateX(-50%);
}

.region-lats {
  right: 10%;
  top: 48%;
}

.region-glutes {
  left: 50%;
  top: 59%;
  transform: translateX(-50%);
}

.region-quads {
  left: 16%;
  bottom: 18%;
}

.region-hamstrings {
  right: 12%;
  bottom: 18%;
}

.region-calves {
  left: 50%;
  bottom: 5%;
  transform: translateX(-50%);
}

.region-dot {
  display: block;
  width: 9px;
  height: 9px;
  margin: 8px auto 0;
  border-radius: 999px;
  background: currentColor;
}

.body-region .region-label,
.body-region small {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.body-region.active {
  border-color: #2563eb;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16), 0 10px 22px rgba(15, 23, 42, 0.16);
}

.body-region.chain {
  border-style: dashed;
}

.tone-high {
  background: #fff1f2;
  color: #9f1239;
}

.tone-medium {
  background: #fffbeb;
  color: #92400e;
}

.tone-good {
  background: #ecfdf5;
  color: #047857;
}

.tone-empty {
  background: #f8fafc;
  color: #475569;
}

@keyframes scan-pass {
  0% {
    top: 12%;
    opacity: 0;
  }

  10%,
  90% {
    opacity: 1;
  }

  100% {
    top: 86%;
    opacity: 0;
  }
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 18px 0;
}

.metric-grid div {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px;
}

.metric-grid dt {
  color: #64748b;
  font-size: 12px;
}

.metric-grid dd {
  margin: 4px 0 0;
  color: #0f172a;
  font-size: 18px;
  font-weight: 700;
}

.detail-section {
  margin-top: 16px;
}

.asset-list,
.overlay-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.asset-list span,
.overlay-list span {
  border-radius: 6px;
  background: #f1f5f9;
  padding: 4px 7px;
  color: #334155;
  font-size: 12px;
}

.muted {
  margin: 8px 0 0;
  color: #64748b;
  font-size: 13px;
}

@media (max-width: 900px) {
  .vital-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .twin-scan {
    min-height: 500px;
  }

  .human-silhouette {
    inset-inline: 52px;
    width: calc(100% - 104px);
  }

  .body-region {
    width: 26px;
    height: 26px;
    min-width: 26px;
    min-height: 26px;
    font-size: 12px;
  }
}
</style>
