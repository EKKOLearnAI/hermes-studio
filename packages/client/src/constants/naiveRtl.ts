import { isRtlLocale } from '@/i18n/direction'

// Naive UI ships one RTL style module per component and enables mirroring only
// for the components handed to NConfigProvider's `rtl` prop. They are not
// re-exported from the package root, so each one is imported from its own
// styles entry.
import { alertRtl } from 'naive-ui/es/alert/styles'
import { avatarGroupRtl } from 'naive-ui/es/avatar-group/styles'
import { badgeRtl } from 'naive-ui/es/badge/styles'
import { buttonRtl } from 'naive-ui/es/button/styles'
import { buttonGroupRtl } from 'naive-ui/es/button-group/styles'
import { cardRtl } from 'naive-ui/es/card/styles'
import { checkboxRtl } from 'naive-ui/es/checkbox/styles'
import { collapseRtl } from 'naive-ui/es/collapse/styles'
import { collapseTransitionRtl } from 'naive-ui/es/collapse-transition/styles'
import { DataTableRtl } from 'naive-ui/es/data-table/styles'
import { dialogRtl } from 'naive-ui/es/dialog/styles'
import { drawerRtl } from 'naive-ui/es/drawer/styles'
import { dynamicInputRtl } from 'naive-ui/es/dynamic-input/styles'
import { flexRtl } from 'naive-ui/es/flex/styles'
// heatmap's styles entry does not re-export its RTL module, so it is imported directly.
import { heatmapRtl } from 'naive-ui/es/heatmap/styles/rtl'
import { inputRtl } from 'naive-ui/es/input/styles'
import { inputNumberRtl } from 'naive-ui/es/input-number/styles'
import { inputOtpRtl } from 'naive-ui/es/input-otp/styles'
import { listRtl } from 'naive-ui/es/list/styles'
import { messageRtl } from 'naive-ui/es/message/styles'
import { notificationRtl } from 'naive-ui/es/notification/styles'
import { paginationRtl } from 'naive-ui/es/pagination/styles'
import { popoverRtl } from 'naive-ui/es/popover/styles'
import { radioRtl } from 'naive-ui/es/radio/styles'
import { selectRtl } from 'naive-ui/es/select/styles'
import { spaceRtl } from 'naive-ui/es/space/styles'
import { statisticRtl } from 'naive-ui/es/statistic/styles'
import { stepsRtl } from 'naive-ui/es/steps/styles'
import { tableRtl } from 'naive-ui/es/table/styles'
import { tagRtl } from 'naive-ui/es/tag/styles'
import { thingRtl } from 'naive-ui/es/thing/styles'
import { treeRtl } from 'naive-ui/es/tree/styles'
import { uploadRtl } from 'naive-ui/es/upload/styles'

export const NAIVE_RTL_STYLES = [
  alertRtl,
  avatarGroupRtl,
  badgeRtl,
  buttonRtl,
  buttonGroupRtl,
  cardRtl,
  checkboxRtl,
  collapseRtl,
  collapseTransitionRtl,
  DataTableRtl,
  dialogRtl,
  drawerRtl,
  dynamicInputRtl,
  flexRtl,
  heatmapRtl,
  inputRtl,
  inputNumberRtl,
  inputOtpRtl,
  listRtl,
  messageRtl,
  notificationRtl,
  paginationRtl,
  popoverRtl,
  radioRtl,
  // Naive UI registers TreeSelect's RTL item under the same 'Select' name, and its
  // only extra peer is treeRtl, which is listed separately below.
  selectRtl,
  spaceRtl,
  statisticRtl,
  stepsRtl,
  tableRtl,
  tagRtl,
  thingRtl,
  treeRtl,
  uploadRtl,
]

/**
 * RTL styles for NConfigProvider, or `undefined` for left-to-right locales so
 * Naive UI keeps its default rendering untouched.
 */
export function naiveRtlFor(locale: string): typeof NAIVE_RTL_STYLES | undefined {
  return isRtlLocale(locale) ? NAIVE_RTL_STYLES : undefined
}
