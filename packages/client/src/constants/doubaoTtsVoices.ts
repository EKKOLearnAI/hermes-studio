export interface DoubaoTtsVoiceOption {
  label: string
  value: string
  resourceId: string
}

export const DOUBAO_TTS_2_RESOURCE_ID = 'seed-tts-2.0'
export const DOUBAO_TTS_DEFAULT_VOICE = 'zh_female_xiaohe_uranus_bigtts'

export const DOUBAO_TTS_VOICE_OPTIONS: DoubaoTtsVoiceOption[] = [
  {
    label: '小何 2.0',
    value: DOUBAO_TTS_DEFAULT_VOICE,
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: 'Vivi 2.0',
    value: 'zh_female_vv_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '云舟 2.0',
    value: 'zh_male_m191_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '小天 2.0',
    value: 'zh_male_taocheng_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '刘飞 2.0',
    value: 'zh_male_liufei_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '魅力苏菲 2.0',
    value: 'zh_male_sophie_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '清新女声 2.0',
    value: 'zh_female_qingxinnvsheng_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '知性灿灿 2.0',
    value: 'zh_female_cancan_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '撒娇学妹 2.0',
    value: 'zh_female_sajiaoxuemei_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '甜美小源 2.0',
    value: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '甜美桃子 2.0',
    value: 'zh_female_tianmeitaozi_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '爽快思思 2.0',
    value: 'zh_female_shuangkuaisisi_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '佩奇猪 2.0',
    value: 'zh_female_peiqi_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '邻家女孩 2.0',
    value: 'zh_female_linjianvhai_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '少年梓辛 2.0',
    value: 'zh_male_shaonianzixin_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '猴哥 2.0',
    value: 'zh_male_sunwukong_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: 'Tina老师 2.0',
    value: 'zh_female_yingyujiaoxue_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '暖阳女声 2.0',
    value: 'zh_female_kefunvsheng_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '儿童绘本 2.0',
    value: 'zh_female_xiaoxue_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '大壹 2.0',
    value: 'zh_male_dayi_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '黑猫侦探社咪仔 2.0',
    value: 'zh_female_mizai_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '鸡汤女 2.0',
    value: 'zh_female_jitangnv_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '魅力女友 2.0',
    value: 'zh_female_meilinvyou_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '流畅女声 2.0',
    value: 'zh_female_liuchangnv_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: '儒雅逸辰 2.0',
    value: 'zh_male_ruyayichen_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: 'Timen 2.0',
    value: 'timen_male_tim_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: 'Dacey 2.0',
    value: 'en_female_dacey_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
  {
    label: 'Stokie 2.0',
    value: 'en_female_stokie_uranus_bigtts',
    resourceId: DOUBAO_TTS_2_RESOURCE_ID,
  },
]

export function doubaoTtsResourceForVoice(voice: string): string {
  return DOUBAO_TTS_VOICE_OPTIONS.find(option => option.value === voice)?.resourceId || ''
}
