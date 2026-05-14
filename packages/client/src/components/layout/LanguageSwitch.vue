<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NSelect } from 'naive-ui'
import { switchLocale } from '@/i18n'

const { locale } = useI18n()

const options = [
  { label: '简体中文', value: 'zh' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: 'English', value: 'en' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
  { label: 'Français', value: 'fr' },
  { label: 'Español', value: 'es' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Português', value: 'pt' },
]

function handleChange(val: string) {
  switchLocale(val)
  localStorage.setItem('hermes_locale', val)
}
</script>

<template>
  <NSelect
    :value="locale"
    :options="options"
    size="tiny"
    :consistent-menu-width="false"
    class="input-sm"
    @update:value="handleChange"
  />
</template>
