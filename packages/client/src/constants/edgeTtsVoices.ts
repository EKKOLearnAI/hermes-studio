export interface EdgeTtsVoiceOption {
  label: string
  value: string
}

/**
 * A shortlist of Edge TTS voices offered in the picker. Edge itself serves
 * hundreds of voices across dozens of languages, so the select that renders
 * these options is taggable: any other Edge voice id (for example
 * `de-DE-KatjaNeural`) can be entered directly and is sent through unchanged.
 */
export const EDGE_TTS_VOICE_OPTIONS: EdgeTtsVoiceOption[] = [
  { label: '晓晓 (zh-CN-XiaoxiaoNeural)', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '晓萱 (zh-CN-XiaoxuanNeural)', value: 'zh-CN-XiaoxuanNeural' },
  { label: '云希 (zh-CN-YunxiNeural)', value: 'zh-CN-YunxiNeural' },
  { label: '云健 (zh-CN-YunjianNeural)', value: 'zh-CN-YunjianNeural' },
  { label: '云扬 (zh-CN-YunyangNeural)', value: 'zh-CN-YunyangNeural' },
  { label: 'Jenny (en-US-JennyNeural)', value: 'en-US-JennyNeural' },
  { label: 'Aria (en-US-AriaNeural)', value: 'en-US-AriaNeural' },
  { label: 'Guy (en-US-GuyNeural)', value: 'en-US-GuyNeural' },
  { label: 'حامد (ar-SA-HamedNeural)', value: 'ar-SA-HamedNeural' },
  { label: 'زارية (ar-SA-ZariyahNeural)', value: 'ar-SA-ZariyahNeural' },
]
