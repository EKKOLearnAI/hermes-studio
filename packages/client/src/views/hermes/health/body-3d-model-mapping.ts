import type { BodyRegionId } from './body-visualization'

export type AnatomyAssetSide = 'left' | 'right' | 'center'

export interface AnatomyRegionAsset {
  file: string
  side: AnatomyAssetSide
}

export interface AnatomyRegionDefinition {
  regionId: BodyRegionId
  label: string
  assets: AnatomyRegionAsset[]
  bodyMapKeys: string[]
  defaultCameraView: 'front' | 'back' | 'left' | 'right'
}

export type PostureIssueOverlayStyle = 'arrow_arc' | 'rotation_band' | 'tilt_axis' | 'warning_ring'

export interface PostureIssueOverlayDefinition {
  id: string
  label: string
  style: PostureIssueOverlayStyle
  regionIds: BodyRegionId[]
  emphasis: 'high' | 'medium'
}

const BODY_PARTS_3D_ROOT = '/models/health/bodyparts3d'

export const ANATOMY_REGION_DEFINITIONS: AnatomyRegionDefinition[] = [
  {
    regionId: 'chest',
    label: '胸部',
    bodyMapKeys: ['upper_chest'],
    defaultCameraView: 'front',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA34690.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA45874.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA79979.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA34691.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA45875.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA79980.stl` },
    ],
  },
  {
    regionId: 'shoulders',
    label: '肩部',
    bodyMapKeys: ['rear_delts'],
    defaultCameraView: 'back',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA34680.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA34682.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA34684.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA34681.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA34683.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA34685.stl` },
    ],
  },
  {
    regionId: 'biceps',
    label: '肱二头',
    bodyMapKeys: ['biceps'],
    defaultCameraView: 'front',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA37684.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA37686.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA37685.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA37687.stl` },
    ],
  },
  {
    regionId: 'forearms',
    label: '前臂',
    bodyMapKeys: ['forearms'],
    defaultCameraView: 'front',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA38486.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA38501.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA38487.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA38502.stl` },
    ],
  },
  {
    regionId: 'abs',
    label: '核心',
    bodyMapKeys: ['abs', 'core'],
    defaultCameraView: 'front',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA13377.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA13378.stl` },
    ],
  },
  {
    regionId: 'lats',
    label: '背阔肌',
    bodyMapKeys: ['lats'],
    defaultCameraView: 'back',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA13358.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA13359.stl` },
    ],
  },
  {
    regionId: 'glutes',
    label: '臀部',
    bodyMapKeys: ['glutes'],
    defaultCameraView: 'back',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA22328.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA22329.stl` },
    ],
  },
  {
    regionId: 'quads',
    label: '股四头',
    bodyMapKeys: ['quads'],
    defaultCameraView: 'front',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA38928.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA38930.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA38932.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA38929.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA38931.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA38933.stl` },
    ],
  },
  {
    regionId: 'hamstrings',
    label: '腘绳肌',
    bodyMapKeys: ['hamstrings'],
    defaultCameraView: 'back',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA45888.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA22358.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA22448.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA45889.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA22359.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA22449.stl` },
    ],
  },
  {
    regionId: 'calves',
    label: '小腿',
    bodyMapKeys: ['calves'],
    defaultCameraView: 'back',
    assets: [
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA45957.stl` },
      { side: 'right', file: `${BODY_PARTS_3D_ROOT}/FMA45960.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA45958.stl` },
      { side: 'left', file: `${BODY_PARTS_3D_ROOT}/FMA45961.stl` },
    ],
  },
]

export const POSTURE_ISSUE_OVERLAY_DEFINITIONS: PostureIssueOverlayDefinition[] = [
  { id: 'right_scapular_downward_rotation', label: '右侧肩胛下回旋', style: 'arrow_arc', regionIds: ['shoulders', 'lats'], emphasis: 'high' },
  { id: 'ribcage_right_rotation', label: '胸廓右旋', style: 'rotation_band', regionIds: ['chest', 'abs', 'lats'], emphasis: 'high' },
  { id: 'pelvic_anterior_tilt', label: '骨盆前倾', style: 'tilt_axis', regionIds: ['abs', 'glutes', 'hamstrings'], emphasis: 'high' },
  { id: 'pelvic_right_rotation', label: '骨盆右旋', style: 'rotation_band', regionIds: ['glutes', 'abs'], emphasis: 'high' },
  { id: 'right_pelvis_elevation', label: '右侧骨盆偏高', style: 'tilt_axis', regionIds: ['glutes', 'quads', 'hamstrings'], emphasis: 'high' },
  { id: 'thoracic_kyphosis', label: '胸椎后凸', style: 'warning_ring', regionIds: ['chest', 'shoulders', 'lats'], emphasis: 'medium' },
  { id: 'lumbar_left_convexity', label: '腰段左凸', style: 'warning_ring', regionIds: ['abs', 'glutes'], emphasis: 'medium' },
  { id: 'head_forward', label: '头前引', style: 'warning_ring', regionIds: ['shoulders'], emphasis: 'medium' },
  { id: 'right_upper_trapezius_tightness', label: '右侧斜方肌紧绷', style: 'warning_ring', regionIds: ['shoulders'], emphasis: 'medium' },
]

export function getAnatomyRegionDefinition(regionId: BodyRegionId): AnatomyRegionDefinition {
  const region = ANATOMY_REGION_DEFINITIONS.find(item => item.regionId === regionId)
  if (!region) throw new Error(`Unknown anatomy region: ${regionId}`)
  return region
}

export function getPostureIssueOverlayDefinitions(): PostureIssueOverlayDefinition[] {
  return POSTURE_ISSUE_OVERLAY_DEFINITIONS
}
