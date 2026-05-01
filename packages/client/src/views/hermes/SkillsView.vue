<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import { fetchSkills, type SkillCategory, type SkillSource, type SkillInfo } from '@/api/hermes/skills'

type SourceFilter = SkillSource | 'modified'

const { t } = useI18n()
const categories = ref<SkillCategory[]>([])
const archived = ref<SkillInfo[]>([])
const loading = ref(false)
const selectedCategory = ref('')
const selectedSkill = ref('')
const searchQuery = ref('')
const showSidebar = ref(true)
const sourceFilter = ref<SourceFilter | null>(null)
let mobileQuery: MediaQueryList | null = null

const selectedSkillData = computed(() => {
  if (!selectedCategory.value || !selectedSkill.value) return null
  if (selectedCategory.value === '.archive') {
    return archived.value.find(s => s.name === selectedSkill.value) ?? null
  }
  const cat = categories.value.find(c => c.name === selectedCategory.value)
  return cat?.skills.find(s => s.name === selectedSkill.value) ?? null
})

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  showSidebar.value = !e.matches
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  loadSkills()
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
})

async function loadSkills() {
  loading.value = true
  try {
    const data = await fetchSkills()
    categories.value = data.categories
    archived.value = data.archived
  } catch (err: any) {
    console.error('Failed to load skills:', err)
  } finally {
    loading.value = false
  }
}

function toggleFilter(filter: SourceFilter) {
  sourceFilter.value = sourceFilter.value === filter ? null : filter
}

function handleSelect(category: string, skill: string) {
  selectedCategory.value = category
  selectedSkill.value = skill
  if (window.innerWidth <= 768) {
    showSidebar.value = false
  }
}

function handlePinToggled(name: string, pinned: boolean) {
  // Update local state so the pin icon updates immediately
  if (selectedCategory.value === '.archive') {
    const skill = archived.value.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  } else {
    const cat = categories.value.find(c => c.name === selectedCategory.value)
    const skill = cat?.skills.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  }
}
</script>

<template>
  <div class="skills-view">
    <header class="page-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        <h2 class="header-title">{{ t('skills.title') }}</h2>
        <button v-if="!showSidebar" class="sidebar-toggle" @click="showSidebar = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>
      <div class="source-legend">
        <button class="legend-item" :class="{ active: sourceFilter === 'builtin' }" @click="toggleFilter('builtin')">
          <span class="legend-dot dot-builtin" />{{ t('skills.source.builtin') }}
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'hub' }" @click="toggleFilter('hub')">
          <span class="legend-dot dot-hub" />{{ t('skills.source.hub') }}
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'local' }" @click="toggleFilter('local')">
          <span class="legend-dot dot-local" />{{ t('skills.source.local') }}
        </button>
        <button class="legend-item" :class="{ active: sourceFilter === 'modified' }" @click="toggleFilter('modified')">
          <span class="modified-icon">✎</span>{{ t('skills.modified') }}
        </button>
      </div>
      <NInput
        v-model:value="searchQuery"
        :placeholder="t('skills.searchPlaceholder')"
        size="small"
        clearable
        style="width: 160px"
      />
    </header>

    <div class="skills-content">
      <div v-if="loading && categories.length === 0" class="skills-loading">{{ t('common.loading') }}</div>
      <div v-else class="skills-layout">
          <div class="mobile-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
          <div v-if="showSidebar" class="skills-sidebar">
            <SkillList
              :categories="categories"
              :archived="archived"
              :selected-skill="selectedCategory && selectedSkill ? `${selectedCategory}/${selectedSkill}` : null"
              :search-query="searchQuery"
              :source-filter="sourceFilter"
              @select="handleSelect"
            />
          </div>
          <div class="skills-main">
            <SkillDetail
              v-if="selectedCategory && selectedSkill"
              :category="selectedCategory"
              :skill="selectedSkill"
              :skill-name="selectedSkillData?.name || selectedSkill"
              :patch-count="selectedSkillData?.patchCount"
              :use-count="selectedSkillData?.useCount"
              :view-count="selectedSkillData?.viewCount"
              :pinned="selectedSkillData?.pinned"
              @pin-toggled="handlePinToggled"
            />
            <div v-else class="empty-detail">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>{{ t('skills.noMatch') }}</span>
            </div>
          </div>
        </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skills-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.source-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
  margin-left: 16px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: $text-muted;
  white-space: nowrap;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: none;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  &.active {
    color: $text-primary;
    border-color: $border-color;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend-dot.dot-builtin { background: #888; }
.legend-dot.dot-hub { background: #4a90d9; }
.legend-dot.dot-local { background: #66bb6a; }

.modified-icon {
  font-size: 11px;
  color: $warning;
  opacity: 0.7;
}

@media (max-width: $breakpoint-mobile) {
  .source-legend {
    display: none;
  }
}

.search-input {
  width: 100px;

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
  }
}

.skills-content {
  flex: 1;
  overflow: hidden;
}

.skills-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: $text-muted;
}

.skills-layout {
  display: flex;
  height: 100%;
}

.skills-sidebar {
  width: 280px;
  border-right: 1px solid $border-color;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.skills-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-width: 0;
}

.sidebar-toggle {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

@media (max-width: $breakpoint-mobile) {
  .sidebar-toggle {
    display: flex;
  }

  .skills-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 10;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
  }

  .skills-layout {
    position: relative;
  }

  .mobile-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.empty-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-muted;
  font-size: 13px;
}
</style>
