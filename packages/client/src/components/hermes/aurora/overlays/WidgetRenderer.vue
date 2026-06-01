<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  onErrorCaptured,
  onMounted,
  ref,
  watch,
  type Component,
  type PropType,
} from 'vue'
import {
  findGeneratedWidget,
  listGeneratedWidgets,
  normalizeGeneratedWidgetName,
  type GeneratedWidgetModule,
} from '@/services/hermes/aurora/generated-widgets'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'
import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'

const props = defineProps<{
  widgetName: string
  componentPath?: string
}>()

const availableWidgets = computed(() =>
  listGeneratedWidgets().map(entry => entry.widgetName).slice(0, 8),
)

const safeWidgetName = computed(() => normalizeGeneratedWidgetName(props.widgetName))
const moduleEntry = computed(() => safeWidgetName.value ? findGeneratedWidget(safeWidgetName.value) : null)
const renderError = ref('')
const lastKnownGoodWidget = ref<Component | null>(null)
const vibeCodingStore = useVibeCodingStore()
const loadedWidgetCache = new Map<string, Component>()

const InlineErrorComponent = defineComponent({
  name: 'GeneratedWidgetAsyncError',
  setup() {
    return () => h('div', { class: 'widget-renderer-failure' }, [
      h('span', { class: 'widget-renderer-symbol' }, '!'),
      h('strong', 'Widget rendering failed or not found'),
      h('p', 'Aurora blocked the broken async component before it could affect the shell.'),
    ])
  },
})

const WidgetRuntimeHost = defineComponent({
  name: 'GeneratedWidgetRuntimeHost',
  props: {
    component: {
      type: Object as PropType<Component>,
      required: true,
    },
    widgetName: {
      type: String,
      required: true,
    },
    promote: {
      type: Function as PropType<(widgetName: string, component: Component) => void>,
      required: true,
    },
  },
  setup(hostProps) {
    onMounted(() => {
      hostProps.promote(hostProps.widgetName, hostProps.component)
    })
    return () => h(hostProps.component)
  },
})

const asyncWidget = computed<Component | null>(() => {
  const entry = moduleEntry.value
  if (!entry) return null

  return defineAsyncComponent({
    loader: async () => {
      try {
        const loaded = await entry.loader() as GeneratedWidgetModule
        if (!loaded?.default) throw new Error('Generated widget has no default export.')
        return loaded.default
      } catch (error: any) {
        handleRuntimeError(error)
        throw error
      }
    },
    delay: 120,
    timeout: 10_000,
    errorComponent: InlineErrorComponent,
  })
})

const componentToRender = computed(() =>
  renderError.value && lastKnownGoodWidget.value ? lastKnownGoodWidget.value : asyncWidget.value,
)

function promoteLoadedWidget(widgetName: string, component: Component) {
  loadedWidgetCache.set(widgetName, component)
  if (safeWidgetName.value === widgetName && !renderError.value) {
    lastKnownGoodWidget.value = component
  }
}

function handleRuntimeError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : 'Widget rendering failed or not found.'
  const stack = error instanceof Error ? error.stack : undefined
  renderError.value = message
  const widgetName = safeWidgetName.value || props.widgetName
  const componentPath = props.componentPath || moduleEntry.value?.componentPath

  auroraEventBus.publish('GENERATED_WIDGET_RUNTIME_ERROR', {
    widgetName,
    componentPath,
    message,
    stack,
    occurredAt: new Date().toISOString(),
  })
  vibeCodingStore.queueRuntimeFix({
    widgetName,
    componentPath,
    errorMessage: message,
    stack,
  })
}

watch(
  () => props.widgetName,
  () => {
    renderError.value = ''
    lastKnownGoodWidget.value = safeWidgetName.value
      ? loadedWidgetCache.get(safeWidgetName.value) || null
      : null
  },
  { immediate: true },
)

onErrorCaptured((error) => {
  handleRuntimeError(error)
  return false
})
</script>

<template>
  <section class="widget-renderer" aria-label="Generated widget renderer">
    <header class="widget-renderer-header">
      <div>
        <p>Generated Component</p>
        <h3>{{ safeWidgetName || widgetName }}</h3>
      </div>
      <span>{{ componentPath || moduleEntry?.componentPath || `components/generated/${safeWidgetName || widgetName}.vue` }}</span>
    </header>

    <div
      v-if="!safeWidgetName || !moduleEntry || (renderError && !lastKnownGoodWidget)"
      class="widget-renderer-failure"
      role="status"
    >
      <span class="widget-renderer-symbol" aria-hidden="true">!</span>
      <strong>Widget rendering failed or not found</strong>
      <p>
        Aurora only loads safe Vue files inside <code>components/generated</code>.
        <template v-if="availableWidgets.length">
          Available: {{ availableWidgets.join(', ') }}
        </template>
      </p>
    </div>

    <Suspense v-else>
      <div class="widget-renderer-runtime">
        <div v-if="renderError && lastKnownGoodWidget" class="widget-renderer-rollback" role="status">
          Runtime watchdog restored the last known good widget and queued a self-healing fix.
        </div>
        <WidgetRuntimeHost
          v-if="componentToRender && safeWidgetName"
          :component="componentToRender"
          :widget-name="safeWidgetName"
          :promote="promoteLoadedWidget"
        />
      </div>
      <template #fallback>
        <div class="widget-renderer-loading" role="status">
          <span class="aurora-loader-mark" aria-hidden="true">A</span>
          <strong>Loading generated widget...</strong>
        </div>
      </template>
    </Suspense>
  </section>
</template>

<style scoped lang="scss">
.widget-renderer {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.widget-renderer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.widget-renderer-header div {
  min-width: 0;
}

.widget-renderer-header p {
  margin: 0 0 5px;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.widget-renderer-header h3 {
  margin: 0;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.86);
  font-size: 16px;
  font-weight: 900;
  line-height: 1.18;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget-renderer-header > span {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 5px 8px;
  border: 1px solid rgba(121, 99, 255, 0.2);
  border-radius: 999px;
  color: #7059f7;
  background: rgba(121, 99, 255, 0.08);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget-renderer-loading,
.widget-renderer-failure {
  display: grid;
  justify-items: center;
  gap: 8px;
  min-height: 170px;
  padding: 26px 18px;
  border: 1px solid rgba(255, 255, 255, 0.48);
  border-radius: 18px;
  text-align: center;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.68), rgba(255, 255, 255, 0.42)),
    rgba(255, 255, 255, 0.56);
  box-shadow:
    0 8px 32px rgba(31, 38, 135, 0.07),
    inset 0 1px 0 rgba(255, 255, 255, 0.62);
  backdrop-filter: blur(16px);
}

.widget-renderer-runtime {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.widget-renderer-rollback {
  padding: 9px 11px;
  border: 1px solid rgba(245, 158, 11, 0.24);
  border-radius: 12px;
  color: rgba(146, 64, 14, 0.88);
  background: rgba(245, 158, 11, 0.1);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.35;
}

.aurora-loader-mark,
.widget-renderer-symbol {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 16px;
  color: #fff;
  background: linear-gradient(135deg, #6b6dff, #9f63ff 58%, #c45cff);
  box-shadow: 0 14px 30px rgba(121, 99, 255, 0.24);
  font-size: 20px;
  font-weight: 950;
  line-height: 1;
}

.aurora-loader-mark {
  animation: aurora-loader-pulse 1.2s ease-in-out infinite;
}

.widget-renderer-symbol {
  background: linear-gradient(135deg, #ff6b6b, #f97373);
  box-shadow: 0 14px 30px rgba(239, 68, 68, 0.18);
}

.widget-renderer-loading strong,
.widget-renderer-failure strong {
  color: rgba(21, 32, 51, 0.82);
  font-size: 14px;
  font-weight: 900;
  line-height: 1.2;
}

.widget-renderer-failure p {
  max-width: 480px;
  margin: 0;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  line-height: 1.5;
}

.widget-renderer-failure code {
  color: #7059f7;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
}

@keyframes aurora-loader-pulse {
  0%,
  100% {
    opacity: 0.7;
    transform: scale(0.94);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

:global(.dark) .widget-renderer-header p,
:global(.dark) .widget-renderer-failure p {
  color: rgba(237, 243, 255, 0.62);
}

:global(.dark) .widget-renderer-header h3,
:global(.dark) .widget-renderer-loading strong,
:global(.dark) .widget-renderer-failure strong {
  color: rgba(237, 243, 255, 0.9);
}

:global(.dark) .widget-renderer-loading,
:global(.dark) .widget-renderer-failure {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .widget-renderer-rollback {
  border-color: rgba(245, 158, 11, 0.24);
  color: rgba(253, 230, 138, 0.88);
  background: rgba(245, 158, 11, 0.1);
}
</style>
