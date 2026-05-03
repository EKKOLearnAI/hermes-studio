<script setup lang="ts">
import { ref, computed } from 'vue'
import { NSwitch, useMessage } from 'naive-ui'
import type { SkillCategory, SkillSource, SkillInfo } from '@/api/hermes/skills'
import { toggleSkill } from '@/api/hermes/skills'
import { useI18n } from 'vue-i18n'

type SourceFilter = SkillSource | 'modified'

const { t } = useI18n()
const message = useMessage()

const props = defineProps<{
    categories: SkillCategory[]
    archived: SkillInfo[]
    selectedSkill: string | null
    searchQuery: string
    sourceFilter: SourceFilter | null
}>()

const emit = defineEmits<{
    select: [category: string, skill: string]
}>()

const collapsedCategories = ref<Set<string>>(new Set())
const archiveCollapsed = ref(true)
const togglingSkills = ref<Set<string>>(new Set())

const filteredArchived = computed(() => {
    let result = props.archived
    if (props.sourceFilter && props.sourceFilter !== 'modified') {
        result = result.filter(s => (s.source || 'local') === props.sourceFilter)
    }
    if (props.searchQuery) {
        const q = props.searchQuery.toLowerCase()
        result = result.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    }
    return result
})

const filteredCategories = computed(() => {
    let result = props.categories

    // Filter by source
    if (props.sourceFilter) {
        result = result
            .map(cat => ({
                ...cat,
                skills: cat.skills.filter(s => {
                    if (props.sourceFilter === 'modified') return s.modified
                    return (s.source || 'local') === props.sourceFilter
                }),
            }))
            .filter(cat => cat.skills.length > 0)
    }

    // Filter by search query
    if (props.searchQuery) {
        const q = props.searchQuery.toLowerCase()
        result = result
            .map(cat => ({
                ...cat,
                skills: cat.skills.filter(
                    s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
                ),
            }))
            .filter(cat => cat.skills.length > 0 || cat.name.toLowerCase().includes(q))
    }

    return result
})

function toggleCategory(name: string) {
    if (collapsedCategories.value.has(name)) {
        collapsedCategories.value.delete(name)
    } else {
        collapsedCategories.value.add(name)
    }
}

function handleSelect(category: string, skillName: string) {
    emit('select', category, skillName)
}

/** Unique key for selection tracking */
function skillKey(catName: string, skill: { name: string }): string {
    return `${catName}/${skill.name}`
}

async function handleToggle(category: string, skillName: string, newEnabled: boolean) {
    if (togglingSkills.value.has(skillName)) return
    togglingSkills.value.add(skillName)

    try {
        await toggleSkill(skillName, newEnabled)
        // Update local state
        const cat = props.categories.find(c => c.name === category)
        const skill = cat?.skills.find(s => s.name === skillName)
        if (skill) skill.enabled = newEnabled
    } catch (err: any) {
        message.error(t('skills.toggleFailed') + `: ${err.message}`)
    } finally {
        togglingSkills.value.delete(skillName)
    }
}
</script>

<template>
    <div class="skill-list">
        <div v-if="filteredCategories.length === 0" class="skill-empty">
            {{ searchQuery ? t('skills.noMatch') : t('skills.noSkills') }}
        </div>
        <div v-for="cat in filteredCategories" :key="cat.name" class="skill-category">
            <button class="category-header" @click="toggleCategory(cat.name)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    class="category-arrow" :class="{ collapsed: collapsedCategories.has(cat.name) }">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
                <span class="category-name">{{ cat.name }}</span>
                <span class="category-count">{{ cat.skills.length }}</span>
            </button>
            <div v-if="!collapsedCategories.has(cat.name)" class="category-skills">
                <button v-for="skill in cat.skills" :key="skillKey(cat.name, skill)" class="skill-item" :class="[
                    { active: selectedSkill === skillKey(cat.name, skill) },
                    `source-${skill.source || 'local'}`,
                ]" @click="handleSelect(cat.name, skill.name)">
                    <div class="skill-info">
                        <span class="skill-name">
                            <span class="source-dot" :class="`dot-${skill.source || 'local'}`"
                                :title="t(`skills.source.${skill.source || 'local'}`)" />
                            {{ skill.name }}
                            <span v-if="skill.modified" class="modified-badge"
                                :title="t('skills.modified')">✎</span>
                        </span>
                        <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                    </div>
                    <NSwitch size="small" :value="skill.enabled !== false" :loading="togglingSkills.has(skill.name)"
                        @update:value="handleToggle(cat.name, skill.name, $event)" @click.stop />
                </button>
            </div>
        </div>

        <!-- Archived skills (separate section) -->
        <div v-if="filteredArchived.length > 0 || archived.length > 0" class="skill-category archive-section">
            <button class="category-header archive-header" @click="archiveCollapsed = !archiveCollapsed">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    class="category-arrow" :class="{ collapsed: archiveCollapsed }">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
                <span class="category-name">{{ t('skills.archived') }}</span>
                <span class="category-count">{{ archived.length }}</span>
            </button>
            <div v-if="!archiveCollapsed" class="category-skills">
                <button v-for="skill in filteredArchived" :key="skillKey('.archive', skill)" class="skill-item skill-archived"
                    :class="{ active: selectedSkill === skillKey('.archive', skill) }"
                    @click="handleSelect('.archive', skill.name)">
                    <div class="skill-info">
                        <span class="skill-name">
                            <span class="source-dot" :class="`dot-${skill.source || 'local'}`"
                                :title="t(`skills.source.${skill.source || 'local'}`)" />
                            {{ skill.name }}
                        </span>
                        <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                    </div>
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skill-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
}

.skill-empty {
    padding: 24px 16px;
    font-size: 13px;
    color: $text-muted;
    text-align: center;
}

.skill-category {
    margin-bottom: 4px;
}

.category-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: none;
    color: $text-secondary;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    cursor: pointer;
    border-radius: $radius-sm;

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.04);
    }
}

.category-arrow {
    flex-shrink: 0;
    transition: transform $transition-fast;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

.category-name {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.category-count {
    font-size: 11px;
    color: $text-muted;
    background: rgba(var(--accent-primary-rgb), 0.06);
    padding: 1px 6px;
    border-radius: 8px;
}

.category-skills {
    padding: 2px 0 4px;
}

.skill-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    padding: 6px 10px 6px 28px;
    border: none;
    background: none;
    color: $text-secondary;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: $radius-sm;
    transition: all $transition-fast;
    gap: 8px;

    &:hover {
        background: rgba(var(--accent-primary-rgb), 0.06);
        color: $text-primary;
    }

    &.active {
        background: rgba(var(--accent-primary-rgb), 0.1);
        color: $text-primary;
        font-weight: 500;
    }
}

// Source indicator dot
.source-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    flex-shrink: 0;
    vertical-align: middle;
}

.dot-builtin {
    background: #888;
}

.dot-hub {
    background: #4a90d9;
}

.dot-local {
    background: #66bb6a;
}

.skill-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.skill-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.modified-badge {
    font-size: 11px;
    color: $warning;
    margin-left: 2px;
    opacity: 0.7;
}

.skill-desc {
    font-size: 11px;
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
}

.archive-section {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid $border-color;
}

.archive-header {
    color: $text-muted;
}

.skill-archived {
    opacity: 0.6;
    padding-left: 28px;
}
</style>
