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
          <h3>肌群与体态地图</h3>
        </div>
        <div class="asset-count">{{ selectedAnatomy.assets.length }} STL</div>
      </div>

      <div class="body-map" aria-label="Body region selector">
        <button
          v-for="region in regionSummaries"
          :key="region.anatomy.regionId"
          type="button"
          class="body-region"
          :class="[`tone-${region.tone}`, { active: activeRegion === region.anatomy.regionId, chain: compensationRegions.has(region.anatomy.regionId) }]"
          :data-test="`body-region-${region.anatomy.regionId}`"
          @click="selectRegion(region.anatomy.regionId)"
        >
          <span>{{ region.anatomy.label }}</span>
          <small>{{ toneLabel(region.tone) }}</small>
        </button>
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
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
  gap: 16px;
}

.viewer-main,
.viewer-details {
  border: 1px solid var(--border-color, #d7dde8);
  border-radius: 8px;
  background: var(--card-color, #fff);
}

.viewer-main {
  min-height: 440px;
  padding: 18px;
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
.tone-pill {
  flex: none;
  border-radius: 999px;
  padding: 4px 9px;
  background: #f1f5f9;
  color: #334155;
  font-size: 12px;
  font-weight: 650;
}

.body-map {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.body-region {
  min-height: 72px;
  border: 1px solid #d8e0ec;
  border-radius: 8px;
  background: #f8fafc;
  color: #0f172a;
  text-align: left;
  padding: 12px;
  cursor: pointer;
}

.body-region span,
.body-region small {
  display: block;
}

.body-region span {
  font-weight: 700;
}

.body-region small {
  margin-top: 6px;
  color: #64748b;
}

.body-region.active {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.14);
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
  .health-body-viewer {
    grid-template-columns: 1fr;
  }
}
</style>
