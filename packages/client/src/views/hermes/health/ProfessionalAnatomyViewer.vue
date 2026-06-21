<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { AnatomyRegionAsset } from './body-3d-model-mapping'
import type { Group, PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const props = defineProps<{
  assets: AnatomyRegionAsset[]
  highlightedAssets?: string[]
  label: string
  tone: string
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const status = ref('准备加载专业解剖模型')
const loadedCount = ref(0)
const cleanup = shallowRef<(() => void) | null>(null)
const meshMaterials = shallowRef<Array<{ file: string; material: { color: { set: (value: number) => void }; opacity: number; needsUpdate: boolean } }>>([])

onMounted(loadModel)
onBeforeUnmount(disposeViewer)

watch(
  () => props.assets.map(asset => asset.file).join('|'),
  () => {
    void loadModel()
  },
)

watch(
  () => `${props.tone}|${props.highlightedAssets?.join('|') || ''}`,
  applyHighlight,
)

async function loadModel() {
  disposeViewer()
  loadedCount.value = 0
  meshMaterials.value = []
  status.value = '正在加载专业解剖模型'
  await nextTick()

  const canvas = canvasRef.value
  if (!canvas || typeof window === 'undefined') return
  if (!('WebGLRenderingContext' in window)) {
    status.value = '当前环境不支持 WebGL'
    return
  }

  try {
    const [THREE, { STLLoader }, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/examples/jsm/loaders/STLLoader.js'),
      import('three/examples/jsm/controls/OrbitControls.js'),
    ])

    const host = canvas.parentElement
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 2000)
    camera.position.set(0, 0.1, 8.2)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.minDistance = 2.2
    controls.maxDistance = 12

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa0b8, 2.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8)
    keyLight.position.set(4, 5, 7)
    scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 1.5)
    rimLight.position.set(-4, 2, -4)
    scene.add(rimLight)

    const modelRoot = new THREE.Group()
    const anatomy = new THREE.Group()
    anatomy.rotation.x = -Math.PI / 2
    modelRoot.add(anatomy)
    scene.add(modelRoot)

    const loader = new STLLoader()
    const highlighted = new Set(props.highlightedAssets || [])
    for (const asset of props.assets) {
      const geometry = await loader.loadAsync(asset.file)
      geometry.computeVertexNormals()
      const isHighlighted = highlighted.has(asset.file)
      const material = new THREE.MeshStandardMaterial({
        color: isHighlighted ? toneColor(props.tone) : 0x60a5fa,
        roughness: 0.58,
        metalness: 0.08,
        transparent: true,
        opacity: isHighlighted ? 0.94 : 0.26,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = asset.file
      anatomy.add(mesh)
      meshMaterials.value = [...meshMaterials.value, { file: asset.file, material }]
      loadedCount.value += 1
    }

    fitGroup(THREE, modelRoot, camera, controls)
    status.value = '可旋转 / 缩放'

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    let frame = 0
    const animate = () => {
      frame = window.requestAnimationFrame(animate)
      modelRoot.rotation.y += 0.002
      controls.update()
      renderer.render(scene, camera)
    }

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(host)
    resize()
    animate()

    cleanup.value = () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      controls.dispose()
      modelRoot.traverse(object => {
        if (!('isMesh' in object)) return
        const mesh = object as typeof object & {
          geometry?: { dispose: () => void }
          material?: { dispose: () => void } | Array<{ dispose: () => void }>
        }
        mesh.geometry?.dispose()
        if (Array.isArray(mesh.material)) mesh.material.forEach(item => item.dispose())
        else mesh.material?.dispose()
      })
      renderer.dispose()
    }
  } catch (error) {
    status.value = error instanceof Error ? `模型加载失败：${error.message}` : '模型加载失败'
  }
}

function applyHighlight() {
  const highlighted = new Set(props.highlightedAssets || [])
  meshMaterials.value.forEach(({ file, material }) => {
    const isHighlighted = highlighted.has(file)
    material.color.set(isHighlighted ? toneColor(props.tone) : 0x60a5fa)
    material.opacity = isHighlighted ? 0.94 : 0.26
    material.needsUpdate = true
  })
}

function fitGroup(
  THREE: typeof import('three'),
  group: Group,
  camera: PerspectiveCamera,
  controls: OrbitControls,
) {
  const box = new THREE.Box3().setFromObject(group)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z) || 1
  const scale = 4.5 / maxDimension
  group.scale.setScalar(scale)
  group.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
  camera.position.set(0, 0.1, 8.2)
  controls.target.set(0, 0.05, 0)
  controls.update()
}

function toneColor(tone: string): number {
  if (tone === 'high') return 0xfb7185
  if (tone === 'medium') return 0xf59e0b
  if (tone === 'good') return 0x34d399
  return 0x60a5fa
}

function disposeViewer() {
  cleanup.value?.()
  cleanup.value = null
}
</script>

<template>
  <div class="professional-anatomy-viewer" data-test="professional-anatomy-viewer">
    <canvas ref="canvasRef" class="anatomy-canvas" data-test="anatomy-model-canvas"></canvas>
    <div class="viewer-overlay">
      <span>专业解剖模型</span>
      <strong>{{ label }}</strong>
      <small>{{ loadedCount }} / {{ assets.length }} STL · {{ status }}</small>
    </div>
  </div>
</template>

<style scoped>
.professional-anatomy-viewer {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
}

.anatomy-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.viewer-overlay {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 3;
  max-width: min(280px, calc(100% - 24px));
  border: 1px solid rgba(148, 163, 184, 0.36);
  border-radius: 8px;
  background: rgba(248, 250, 252, 0.9);
  padding: 9px 10px;
  backdrop-filter: blur(8px);
}

.viewer-overlay span,
.viewer-overlay strong,
.viewer-overlay small {
  display: block;
}

.viewer-overlay span {
  color: #0369a1;
  font-size: 12px;
  font-weight: 700;
}

.viewer-overlay strong {
  margin-top: 2px;
  color: #0f172a;
}

.viewer-overlay small {
  margin-top: 2px;
  color: #64748b;
  font-size: 11px;
}
</style>
