<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NModal, NSelect, NSpin, NTabPane, NTabs, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchPetdexManifest, type PetdexManifest, type PetdexPet } from '@/api/hermes/petdex'
import { deleteLocalPet, fetchLocalPets, importLocalPet, type LocalImportedPet } from '@/api/hermes/pets'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '@/api/client'
import { usePetsStore } from '@/stores/hermes/pets'
import { desktopBridge } from '@/utils/desktop-bridge'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const petsStore = usePetsStore()

type TabKey = 'petdex' | 'local'
const activeTab = ref<TabKey>('petdex')

const manifest = ref<PetdexManifest | null>(null)
const loading = ref(false)
const adoptingSlug = ref('')
const deletingSlug = ref('')
const error = ref('')
const searchQuery = ref('')
const kindFilter = ref<string | null>(null)
const visibleLimit = ref(96)
const DESKTOP_ADOPT_SCALE = 0.58

const localPets = ref<LocalImportedPet[]>([])
const loadingLocal = ref(false)
const localSearchQuery = ref('')
const localPetBlobUrls = ref<Map<string, string>>(new Map())
const localPetBlobPromises = new Map<string, Promise<string | null>>()

function getApiBaseUrl(): string {
  return getBaseUrlValue()
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const apiKey = getApiKey()
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const profileName = getActiveProfileName()
  if (profileName) headers['X-Hermes-Profile'] = profileName
  return headers
}

// Import modal state
const showImportModal = ref(false)
const importing = ref(false)
const importForm = ref({
  displayName: '',
  kind: 'pet',
  submittedBy: '',
})
const spritesheetFile = ref<File | null>(null)
const petJsonFile = ref<File | null>(null)
const petJsonText = ref<string | null>(null)
const importError = ref('')
const importHint = ref('')
const previewFrame = ref(0)
const PREVIEW_FRAME_COUNT = 8
const PREVIEW_FRAME_MS = 130

let previewTimer: ReturnType<typeof setInterval> | null = null

const previewUrl = computed(() =>
  spritesheetFile.value ? URL.createObjectURL(spritesheetFile.value) : '',
)
let currentPreviewUrl = ''
watch(previewUrl, (url) => {
  if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl)
  currentPreviewUrl = url
})

const spriteDimensions = ref<{ width: number; height: number } | null>(null)

watch(spritesheetFile, (file) => {
  spriteDimensions.value = null
  if (!file) return
  const img = new Image()
  img.onload = () => {
    spriteDimensions.value = { width: img.naturalWidth, height: img.naturalHeight }
  }
  img.src = URL.createObjectURL(file)
})

const previewStyle = computed(() => {
  const frame = previewFrame.value
  const xPercent = (frame * 100) / (PREVIEW_FRAME_COUNT - 1)
  return {
    backgroundImage: previewUrl.value ? `url("${previewUrl.value}")` : 'none',
    backgroundSize: `${PREVIEW_FRAME_COUNT * 100}% auto`,
    backgroundPosition: `${xPercent}% 0%`,
    backgroundRepeat: 'no-repeat' as const,
  }
})

function startPreviewAnimation() {
  stopPreviewAnimation()
  if (!showImportModal.value || !spritesheetFile.value) return
  previewFrame.value = 0
  previewTimer = setInterval(() => {
    previewFrame.value = (previewFrame.value + 1) % PREVIEW_FRAME_COUNT
  }, PREVIEW_FRAME_MS)
}

function stopPreviewAnimation() {
  if (previewTimer) {
    clearInterval(previewTimer)
    previewTimer = null
  }
}

watch([showImportModal, spritesheetFile], ([visible, file]) => {
  if (visible && file) {
    startPreviewAnimation()
  } else {
    stopPreviewAnimation()
    previewFrame.value = 0
  }
})

onBeforeUnmount(() => {
  stopPreviewAnimation()
  if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl)
})

const pets = computed(() => manifest.value?.pets ?? [])
const generatedAt = computed(() => {
  const value = manifest.value?.generatedAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
})

const kindOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const pet of pets.value) {
    counts.set(pet.kind, (counts.get(pet.kind) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({
      label: `${kind} (${count})`,
      value: kind,
    }))
})

const filteredPets = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return pets.value.filter((pet) => {
    if (kindFilter.value && pet.kind !== kindFilter.value) return false
    if (!query) return true
    return [pet.slug, pet.displayName, pet.kind, pet.submittedBy]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

const visiblePets = computed(() => filteredPets.value.slice(0, visibleLimit.value))
const canShowMore = computed(() => visiblePets.value.length < filteredPets.value.length)

const filteredLocalPets = computed(() => {
  const query = localSearchQuery.value.trim().toLowerCase()
  if (!query) return localPets.value
  return localPets.value.filter(pet =>
    [pet.slug, pet.displayName, pet.kind, pet.submittedBy]
      .some(value => String(value || '').toLowerCase().includes(query)),
  )
})

async function loadManifest(force = false) {
  loading.value = true
  error.value = ''
  try {
    manifest.value = await fetchPetdexManifest(force)
    visibleLimit.value = 96
  } catch (err: any) {
    error.value = err?.message || t('petdex.loadFailed')
  } finally {
    loading.value = false
  }
}

function showMore() {
  visibleLimit.value += 96
}

function assetLinks(pet: PetdexPet) {
  return [
    { label: t('petdex.spritesheet'), href: pet.spritesheetUrl },
    ...(pet.petJsonUrl ? [{ label: 'pet.json', href: pet.petJsonUrl }] : []),
    ...(pet.zipUrl ? [{ label: 'zip', href: pet.zipUrl }] : []),
  ]
}

async function adopt(pet: PetdexPet) {
  adoptingSlug.value = pet.slug
  try {
    await petsStore.adopt(pet.slug)
    const bridge = desktopBridge()
    if (bridge?.isDesktop) {
      await petsStore.savePreferences({ scale: DESKTOP_ADOPT_SCALE })
      await bridge.setPetWindowVisible?.(true).catch(() => undefined)
    }
    message.success(t('petdex.adopted', { name: pet.displayName }))
    void loadLocalPets()
  } catch (err: any) {
    message.error(err?.message || t('petdex.adoptFailed'))
  } finally {
    adoptingSlug.value = ''
  }
}

async function loadLocalPets() {
  loadingLocal.value = true
  try {
    const next = await fetchLocalPets()
    pruneLocalPetBlobUrls(next)
    localPets.value = next
  } catch (err: any) {
    message.warning(err?.message || t('petdex.local.loadFailed'))
  } finally {
    loadingLocal.value = false
  }
}

async function ensureLocalPetBlobUrl(slug: string): Promise<string | null> {
  const cached = localPetBlobUrls.value.get(slug)
  if (cached) return cached
  const inflight = localPetBlobPromises.get(slug)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      // Try the dedicated preview first (first-frame only). Fall back to the
      // full spritesheet so older imports without preview.png still render.
      let url = `${getApiBaseUrl()}/api/hermes/pets/local/${encodeURIComponent(slug)}/preview`
      let res = await fetch(url, { headers: buildAuthHeaders() })
      if (!res.ok) {
        url = `${getApiBaseUrl()}/api/hermes/pets/local/${encodeURIComponent(slug)}/asset`
        res = await fetch(url, { headers: buildAuthHeaders() })
        if (!res.ok) return null
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const next = new Map(localPetBlobUrls.value)
      next.set(slug, blobUrl)
      localPetBlobUrls.value = next
      return blobUrl
    } catch {
      return null
    } finally {
      localPetBlobPromises.delete(slug)
    }
  })()
  localPetBlobPromises.set(slug, promise)
  return promise
}

function localPetPreviewUrl(slug: string): string {
  return localPetBlobUrls.value.get(slug) ?? ''
}

function pruneLocalPetBlobUrls(pets: LocalImportedPet[]) {
  const keep = new Set(pets.map(p => p.slug))
  for (const [slug, url] of localPetBlobUrls.value) {
    if (!keep.has(slug)) {
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      const next = new Map(localPetBlobUrls.value)
      next.delete(slug)
      localPetBlobUrls.value = next
    }
  }
}

function revokeAllLocalPetBlobUrls() {
  for (const url of localPetBlobUrls.value.values()) {
    try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  }
  localPetBlobUrls.value = new Map()
}

async function preloadLocalPetBlobUrls(pets: LocalImportedPet[]) {
  await Promise.all(pets.map(pet => ensureLocalPetBlobUrl(pet.slug)))
}

async function adoptLocal(pet: LocalImportedPet) {
  adoptingSlug.value = pet.slug
  try {
    await petsStore.adopt(pet.slug)
    const bridge = desktopBridge()
    if (bridge?.isDesktop) {
      await petsStore.savePreferences({ scale: DESKTOP_ADOPT_SCALE })
      await bridge.setPetWindowVisible?.(true).catch(() => undefined)
    }
    message.success(t('petdex.adopted', { name: pet.displayName }))
  } catch (err: any) {
    message.error(err?.message || t('petdex.adoptFailed'))
  } finally {
    adoptingSlug.value = ''
  }
}

function confirmRemoveLocalPet(pet: LocalImportedPet) {
  dialog.warning({
    title: t('petdex.local.removeTitle'),
    content: t('petdex.local.removeConfirm', { name: pet.displayName }),
    positiveText: t('petdex.local.remove'),
    negativeText: t('petdex.local.cancel'),
    onPositiveClick: () => removeLocalPet(pet),
  })
}

async function removeLocalPet(pet: LocalImportedPet) {
  deletingSlug.value = pet.slug
  try {
    await deleteLocalPet(pet.slug)
    message.success(t('petdex.local.removed', { name: pet.displayName }))
    // Refresh active pet in case the deleted pet was active.
    if (petsStore.activePet?.slug === pet.slug) {
      await petsStore.loadActivePet()
    }
    void loadLocalPets()
  } catch (err: any) {
    message.error(err?.message || t('petdex.local.removeFailed'))
  } finally {
    deletingSlug.value = ''
  }
}

function openImportModal() {
  importForm.value = { displayName: '', kind: 'pet', submittedBy: '' }
  spritesheetFile.value = null
  petJsonFile.value = null
  petJsonText.value = null
  importError.value = ''
  importHint.value = ''
  previewFrame.value = 0
  spriteDimensions.value = null
  showImportModal.value = true
}

function closeImportModal() {
  showImportModal.value = false
}

const spriteInputRef = ref<HTMLInputElement | null>(null)
const folderInputRef = ref<HTMLInputElement | null>(null)

function pickSpritesheet() {
  spriteInputRef.value?.click()
}

function pickFolder() {
  folderInputRef.value?.click()
}

function onSpritesheetPicked(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0] ?? null
  spritesheetFile.value = file
  importHint.value = ''
  if (file) importHint.value = t('petdex.local.spriteLoaded', { name: file.name })
  target.value = ''
}

function onFolderPicked(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files ? Array.from(target.files) : []
  if (!files.length) {
    target.value = ''
    return
  }

  const sprite = files.find(f => /^spritesheet\.(png|webp|jpg|jpeg|gif)$/i.test(f.name))
  const meta = files.find(f => /^pet\.json$/i.test(f.name))

  if (!sprite) {
    importError.value = t('petdex.local.folderMissingSprite')
    target.value = ''
    return
  }

  spritesheetFile.value = sprite
  importError.value = ''

  if (meta) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = String(reader.result || '')
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          petJsonText.value = text
          petJsonFile.value = meta
          if (autoFillFromMetadata(parsed as Record<string, unknown>)) {
            importHint.value = t('petdex.local.autoFilled', { source: meta.name })
          }
        }
      } catch {
        importError.value = t('petdex.local.petJsonInvalid')
      }
    }
    reader.readAsText(meta)
  } else {
    importHint.value = t('petdex.local.spriteLoaded', { name: sprite.name })
  }
  target.value = ''
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return ''
}

function autoFillFromMetadata(meta: Record<string, unknown>): boolean {
  const displayName = pickString(meta, ['displayName', 'name', 'title'])
  const kind = pickString(meta, ['kind', 'type', 'category'])
  const submittedBy = pickString(meta, ['submittedBy', 'author', 'creator', 'by'])

  let filled = 0
  if (!importForm.value.displayName && displayName) {
    importForm.value.displayName = displayName
    filled += 1
  }
  if ((!importForm.value.kind || importForm.value.kind === 'pet') && kind) {
    importForm.value.kind = kind
    filled += 1
  }
  if (!importForm.value.submittedBy && submittedBy) {
    importForm.value.submittedBy = submittedBy
    filled += 1
  }
  return filled > 0
}

// (legacy NUpload handlers removed; the modal now uses native file inputs)

async function submitImport() {
  importError.value = ''
  if (!spritesheetFile.value) {
    importError.value = t('petdex.local.spritesheetRequired')
    return
  }
  importing.value = true
  try {
    const pet = await importLocalPet({
      slug: importForm.value.displayName,
      displayName: importForm.value.displayName,
      kind: importForm.value.kind,
      submittedBy: importForm.value.submittedBy,
      spritesheet: spritesheetFile.value,
      petJson: petJsonFile.value && petJsonText.value !== null
        ? new File([petJsonText.value], petJsonFile.value.name, { type: petJsonFile.value.type || 'application/json' })
        : petJsonFile.value,
    })
    showImportModal.value = false
    message.success(t('petdex.local.imported', { name: pet.displayName }))
    void loadLocalPets()
  } catch (err: any) {
    importError.value = err?.message || t('petdex.local.importFailed')
  } finally {
    importing.value = false
  }
}

watch(activeTab, (next) => {
  if (next === 'local') {
    void loadLocalPets()
  } else {
    void loadManifest()
  }
})

watch(filteredLocalPets, (next) => {
  void preloadLocalPetBlobUrls(next)
}, { immediate: true })

onBeforeUnmount(() => {
  revokeAllLocalPetBlobUrls()
})

onMounted(() => {
  void loadManifest()
  void loadLocalPets()
  void petsStore.loadActivePet()
})
</script>

<template>
  <div class="petdex-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('petdex.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" quaternary :loading="loading && activeTab === 'petdex'" @click="loadManifest(true)">
          {{ t('petdex.refresh') }}
        </NButton>
      </div>
    </header>

    <div class="petdex-content">
      <NTabs v-model:value="activeTab" type="line" animated>
        <NTabPane name="petdex" :tab="t('petdex.local.tabs.petdex')">
          <div class="tab-content">
            <div v-if="loading && !manifest" class="loading-state">
              <NSpin />
            </div>

            <template v-else>
              <NAlert v-if="error" type="error" class="notice">
                {{ error }}
              </NAlert>

              <div v-if="manifest" class="summary-grid">
                <div class="summary-card">
                  <span>{{ t('petdex.summary.total') }}</span>
                  <strong>{{ manifest.total }}</strong>
                </div>
                <div class="summary-card">
                  <span>{{ t('petdex.summary.visible') }}</span>
                  <strong>{{ filteredPets.length }}</strong>
                </div>
                <div class="summary-card">
                  <span>{{ t('petdex.summary.kinds') }}</span>
                  <strong>{{ kindOptions.length }}</strong>
                </div>
                <div class="summary-card wide">
                  <span>{{ t('petdex.summary.generatedAt') }}</span>
                  <strong>{{ generatedAt || '-' }}</strong>
                </div>
              </div>

              <div class="filter-row">
                <NInput v-model:value="searchQuery" :placeholder="t('petdex.searchPlaceholder')" clearable />
                <NSelect v-model:value="kindFilter" :options="kindOptions" :placeholder="t('petdex.kindFilter')" clearable />
              </div>

              <div v-if="visiblePets.length" class="pet-grid">
                <article v-for="pet in visiblePets" :key="pet.slug" class="pet-card">
                  <div class="pet-preview">
                    <div class="pet-frame" :style="{ backgroundImage: `url(${pet.previewUrl || pet.spritesheetUrl})` }" />
                  </div>
                  <div class="pet-body">
                    <div class="pet-title-row">
                      <h3>{{ pet.displayName }}</h3>
                      <NTag size="small" round>{{ pet.kind }}</NTag>
                    </div>
                    <div class="pet-slug">{{ pet.slug }}</div>
                    <div v-if="pet.submittedBy" class="pet-meta">
                      {{ t('petdex.submittedBy', { name: pet.submittedBy }) }}
                    </div>
                    <div class="pet-links">
                      <a v-for="link in assetLinks(pet)" :key="link.href" :href="link.href" target="_blank" rel="noopener noreferrer">
                        {{ link.label }}
                      </a>
                    </div>
                    <div class="pet-actions">
                      <NButton
                        size="small"
                        type="primary"
                        block
                        :secondary="petsStore.activePet?.slug === pet.slug"
                        :loading="adoptingSlug === pet.slug"
                        :disabled="!!adoptingSlug"
                        @click="adopt(pet)"
                      >
                        {{ petsStore.activePet?.slug === pet.slug ? t('petdex.active') : t('petdex.adopt') }}
                      </NButton>
                    </div>
                  </div>
                </article>
              </div>

              <NEmpty v-else :description="t('petdex.empty')" />

              <div v-if="canShowMore" class="load-more">
                <NButton :disabled="loading" @click="showMore">
                  {{ t('petdex.showMore', { count: Math.min(96, filteredPets.length - visiblePets.length) }) }}
                </NButton>
              </div>
            </template>
          </div>
        </NTabPane>

        <NTabPane name="local" :tab="t('petdex.local.tabs.local')">
          <div class="tab-content">
            <div class="local-toolbar">
              <NInput v-model:value="localSearchQuery" :placeholder="t('petdex.local.searchPlaceholder')" clearable />
              <NButton type="primary" @click="openImportModal">
                {{ t('petdex.local.import') }}
              </NButton>
            </div>

            <NSpin :show="loadingLocal">
              <NEmpty v-if="!localPets.length" :description="t('petdex.local.emptyLocal')" />
              <NEmpty v-else-if="!filteredLocalPets.length" :description="t('petdex.empty')" />
              <div v-else class="pet-grid">
                <article v-for="pet in filteredLocalPets" :key="pet.slug" class="pet-card">
                  <div class="pet-preview">
                    <div
                      class="pet-frame is-installed-preview"
                      :style="{ backgroundImage: `url(${localPetPreviewUrl(pet.slug)})` }"
                    />
                  </div>
                  <div class="pet-body">
                    <div class="pet-title-row">
                      <h3>{{ pet.displayName }}</h3>
                      <NTag
                        size="small"
                        round
                        :type="pet.source === 'local' ? 'warning' : 'info'"
                      >
                        {{ pet.source === 'local' ? t('petdex.local.source.local') : t('petdex.local.source.petdex') }}
                      </NTag>
                    </div>
                    <div class="pet-slug">{{ pet.slug }}</div>
                    <div v-if="pet.submittedBy" class="pet-meta">
                      {{ t('petdex.submittedBy', { name: pet.submittedBy }) }}
                    </div>
                    <div class="pet-actions pet-actions-row">
                      <NButton
                        size="small"
                        type="primary"
                        class="pet-action-main"
                        :secondary="petsStore.activePet?.slug === pet.slug"
                        :loading="adoptingSlug === pet.slug"
                        :disabled="!!adoptingSlug || !!deletingSlug"
                        @click="adoptLocal(pet)"
                      >
                        {{ petsStore.activePet?.slug === pet.slug ? t('petdex.active') : t('petdex.adopt') }}
                      </NButton>
                      <NButton
                        size="small"
                        quaternary
                        type="error"
                        :loading="deletingSlug === pet.slug"
                        :disabled="!!adoptingSlug || !!deletingSlug"
                        @click="confirmRemoveLocalPet(pet)"
                      >
                        {{ t('petdex.local.remove') }}
                      </NButton>
                    </div>
                  </div>
                </article>
              </div>
            </NSpin>
          </div>
        </NTabPane>
      </NTabs>
    </div>

    <NModal
      v-model:show="showImportModal"
      preset="card"
      :title="t('petdex.local.importTitle')"
      style="width: 760px; max-width: 96vw;"
      class="petdex-import-modal"
    >
      <div class="import-grid">
        <section class="import-drop">
          <div class="import-drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 16V4" />
              <path d="M6 10l6-6 6 6" />
              <path d="M20 20H4" />
            </svg>
          </div>
          <h3 class="import-drop-title">{{ t('petdex.local.dropTitle') }}</h3>
          <p class="import-drop-hint">{{ t('petdex.local.dropHint') }}</p>
          <div class="import-drop-actions">
            <NButton type="primary" @click="pickFolder">
              {{ t('petdex.local.pickFolder') }}
            </NButton>
            <NButton quaternary disabled>{{ t('petdex.local.pickZip') }}</NButton>
            <NButton quaternary @click="pickSpritesheet">
              {{ t('petdex.local.pickSpritesheet') }}
            </NButton>
          </div>
          <p class="import-drop-note">{{ t('petdex.local.dropNote') }}</p>
          <input
            ref="spriteInputRef"
            type="file"
            accept="image/*,.png,.jpg,.jpeg,.gif,.webp"
            class="hidden-file-input"
            @change="onSpritesheetPicked"
          >
          <input
            ref="folderInputRef"
            type="file"
            webkitdirectory
            multiple
            class="hidden-file-input"
            @change="onFolderPicked"
          >
        </section>

        <section class="import-review">
          <header class="import-review-header">
            <span class="import-review-title">{{ t('petdex.local.reviewTitle') }}</span>
          </header>

          <div v-if="!spritesheetFile" class="import-review-empty">
            <span class="import-review-emoji" aria-hidden="true">🖼️</span>
            <p>{{ t('petdex.local.reviewEmpty') }}</p>
          </div>

          <template v-else>
            <div class="import-preview" :style="previewStyle" />

            <div v-if="importError" class="import-review-status is-error">
              <span aria-hidden="true">⚠️</span>
              {{ importError }}
            </div>
            <div v-else class="import-review-status is-ok">
              <span aria-hidden="true">✓</span>
              {{ t('petdex.local.reviewReady') }}
            </div>

            <div class="import-review-fields">
              <div class="import-field">
                <label>{{ t('petdex.local.displayName') }}</label>
                <NInput v-model:value="importForm.displayName" :placeholder="t('petdex.local.displayNamePlaceholder')" />
              </div>
              <div class="import-field">
                <label>{{ t('petdex.local.kind') }}</label>
                <NInput v-model:value="importForm.kind" placeholder="pet" />
              </div>
              <div class="import-field">
                <label>{{ t('petdex.local.submittedBy') }}</label>
                <NInput v-model:value="importForm.submittedBy" :placeholder="t('petdex.local.submittedByPlaceholder')" />
              </div>
              <div v-if="spriteDimensions" class="import-review-dims">
                {{ spriteDimensions.width }} × {{ spriteDimensions.height }}
              </div>
            </div>

            <div class="import-actions">
              <NButton @click="closeImportModal">{{ t('petdex.local.cancel') }}</NButton>
              <NButton type="primary" :loading="importing" @click="submitImport">
                {{ t('petdex.local.confirm') }}
              </NButton>
            </div>
          </template>
        </section>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
.petdex-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.petdex-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 28px;
}

.loading-state {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notice {
  margin-bottom: 16px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;

  span {
    color: var(--text-secondary);
    font-size: 12px;
  }

  strong {
    font-size: 20px;
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.filter-row {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 220px;
  gap: 12px;
  margin-bottom: 18px;
}

.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.pet-card {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.pet-preview {
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
}

.pet-frame {
  width: 92px;
  aspect-ratio: 192 / 208;
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: 800% auto;
  background-color: transparent;
  image-rendering: auto;
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.22));
}

.pet-frame.is-installed-preview {
  background-size: 600% auto;
}

.pet-body {
  padding: 12px;
}

.pet-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;

  h3 {
    margin: 0;
    min-width: 0;
    font-size: 15px;
    font-weight: 650;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.pet-slug,
.pet-meta {
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pet-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;

  a {
    color: var(--primary-color);
    font-size: 12px;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

.pet-actions {
  margin-top: 12px;
}

.pet-actions-row {
  display: flex;
  gap: 8px;

  .pet-action-main {
    flex: 1;
  }
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 24px 0 4px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tab-content {
  padding: 16px 0 4px;
}

.local-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 12px;
  margin-bottom: 18px;
  align-items: center;
}

.import-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 20px;
  align-items: stretch;
}

.import-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 20px;
  border: 1px dashed var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  text-align: center;
  min-height: 360px;
}

.import-drop-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--bg-tertiary, rgba(127, 127, 127, 0.12));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
}

.import-drop-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}

.import-drop-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
  max-width: 420px;
}

.import-drop-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 4px;
}

.import-drop-note {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.hidden-file-input {
  display: none;
}

.import-review {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  min-height: 360px;
}

.import-review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.import-review-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.import-review-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-secondary);
  text-align: center;
  font-size: 13px;
}

.import-review-emoji {
  font-size: 32px;
}

.import-preview {
  width: 100%;
  aspect-ratio: 192 / 208;
  max-width: 220px;
  margin: 0 auto;
  background-color: rgba(127, 127, 127, 0.06);
  border-radius: 8px;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.18));
}

.import-review-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;

  &.is-ok {
    background: rgba(46, 204, 113, 0.12);
    color: #2ecc71;
  }

  &.is-error {
    background: rgba(231, 76, 60, 0.12);
    color: #e74c3c;
  }
}

.import-review-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.import-review-dims {
  margin-top: -4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.import-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-size: 12px;
    color: var(--text-secondary);
  }
}

.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: auto;
}

@media (max-width: 720px) {
  .import-grid {
    grid-template-columns: 1fr;
  }

  .import-drop,
  .import-review {
    min-height: auto;
  }
}

@media (max-width: 720px) {
  .petdex-content {
    padding: 16px;
  }

  .summary-grid,
  .filter-row,
  .local-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
