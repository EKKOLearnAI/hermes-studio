const en = {
  title: 'Android Companion',
  subtitle: 'Encrypted Android execution, minimized observations, and durable verification in one control plane.',
  refresh: 'Refresh',
  readOnly: 'You have read-only access. Pairing and revocation require a super administrator.',
  status: {
    kicker: 'Companion fabric', title: 'Android execution readiness', paired: 'Paired devices', connected: 'Connected',
    capabilities: 'Healthy capabilities', commands: 'Active commands', verified: 'Verified receipts',
    notifications: 'Notifications', artifacts: 'Artifacts', takeovers: 'Takeovers', emergencyStop: 'Emergency stop',
    level: 'Level {level}', encrypted: 'Encrypted session online', offline: 'No encrypted session',
  },
  pairing: {
    title: 'Pair a companion', summary: 'Create one short-lived challenge and enter its code on your Android device.',
    issue: 'Create pairing code', offerTitle: 'One-time pairing code', code: 'Code', expires: 'Expires',
    studio: 'Studio identity', cancel: 'Revoke code', privacy: 'The code is held only in this page session and disappears after enrollment or revocation.',
  },
  devices: {
    title: 'Device trust', empty: 'No Android companions are paired.', connected: 'Connected', offline: 'Offline',
    android: 'Android', app: 'Companion app', lastSeen: 'Last seen', signing: 'Signing key', exchange: 'Exchange key',
    revoke: 'Revoke device', revoked: 'Revoked', confirmTitle: 'Revoke this Android companion?',
    confirmSummary: 'The encrypted session will close and all Android executors for this device will be disabled.',
    confirm: 'Revoke and disconnect', cancel: 'Keep device',
  },
  capabilities: {
    title: 'Capabilities and permissions', empty: 'No capability report has been accepted.', package: 'Package',
    driver: 'Driver', permissions: 'Permissions', verification: 'Verification', enabled: 'Enabled', disabled: 'Disabled',
    healthy: 'Healthy', degraded: 'Degraded', unavailable: 'Unavailable',
  },
  takeovers: {
    title: 'Human takeover', empty: 'No active device takeover is required.', deviceAction: 'Continue on the paired phone.',
    reason: 'Reason', generation: 'Generation', expires: 'Expires', requested: 'Requested', claimed: 'Claimed',
    completed: 'Completed', expired: 'Expired', cancelled: 'Cancelled',
  },
  activity: {
    title: 'Bounded activity', commands: 'Commands', receipts: 'Receipts', notifications: 'Notifications',
    artifacts: 'Screen artifacts', empty: 'No records yet.', workflow: 'Workflow', attempts: 'Delivery attempts',
    captured: 'Captured', dimensions: 'Dimensions', removed: 'Removed', active: 'Active', result: 'Result',
  },
  errors: {
    load: 'Failed to load Android Companion', pair: 'Failed to create pairing code',
    revokeOffer: 'Failed to revoke pairing code', revokeDevice: 'Failed to revoke Android companion',
  },
  success: { offer: 'Pairing code created', revokeOffer: 'Pairing code revoked', revokeDevice: 'Android companion revoked' },
}

type Messages = typeof en
type Overrides = Partial<Omit<Messages, 'status' | 'pairing' | 'devices' | 'capabilities' | 'takeovers'
  | 'activity' | 'errors' | 'success'>> & {
  status?: Partial<Messages['status']>; pairing?: Partial<Messages['pairing']>
  devices?: Partial<Messages['devices']>; capabilities?: Partial<Messages['capabilities']>
  takeovers?: Partial<Messages['takeovers']>; activity?: Partial<Messages['activity']>
  errors?: Partial<Messages['errors']>; success?: Partial<Messages['success']>
}
function localized(value: Overrides): Messages {
  return {
    ...en, ...value,
    status: { ...en.status, ...(value.status ?? {}) },
    pairing: { ...en.pairing, ...(value.pairing ?? {}) },
    devices: { ...en.devices, ...(value.devices ?? {}) },
    capabilities: { ...en.capabilities, ...(value.capabilities ?? {}) },
    takeovers: { ...en.takeovers, ...(value.takeovers ?? {}) },
    activity: { ...en.activity, ...(value.activity ?? {}) },
    errors: { ...en.errors, ...(value.errors ?? {}) },
    success: { ...en.success, ...(value.success ?? {}) },
  } as Messages
}

const zh = localized({
  title: 'Android 伴侣', subtitle: '统一管理加密 Android 执行、最小化观察与持久验证。', refresh: '刷新',
  readOnly: '当前为只读权限；配对和撤销设备需要超级管理员。',
  status: { kicker: '伴侣执行网络', title: 'Android 执行就绪状态', paired: '已配对设备', connected: '在线设备', capabilities: '健康能力', commands: '活动命令', verified: '已验证凭证', notifications: '通知观察', artifacts: '屏幕工件', takeovers: '人工接管', emergencyStop: '紧急停止', level: '等级 {level}', encrypted: '加密会话在线', offline: '无加密会话' },
  pairing: { title: '配对伴侣', summary: '创建一个短时有效的挑战，并在 Android 设备上输入配对码。', issue: '创建配对码', offerTitle: '一次性配对码', code: '配对码', expires: '过期时间', studio: 'Studio 身份', cancel: '撤销配对码', privacy: '配对码只保留在当前页面会话中，完成配对或撤销后即消失。' },
  devices: { title: '设备信任', empty: '尚未配对 Android 伴侣。', connected: '在线', offline: '离线', android: 'Android', app: '伴侣应用', lastSeen: '最后在线', signing: '签名密钥', exchange: '交换密钥', revoke: '撤销设备', revoked: '已撤销', confirmTitle: '撤销此 Android 伴侣？', confirmSummary: '加密会话会立即关闭，此设备的所有 Android 执行器都会停用。', confirm: '撤销并断开', cancel: '保留设备' },
  capabilities: { title: '能力与权限', empty: '尚未接受能力报告。', package: '包名', driver: '驱动', permissions: '权限', verification: '验证方式', enabled: '已启用', disabled: '已停用', healthy: '健康', degraded: '降级', unavailable: '不可用' },
  takeovers: { title: '人工接管', empty: '当前没有需要处理的设备接管。', deviceAction: '请在已配对手机上继续。', reason: '原因', generation: '代次', expires: '过期时间', requested: '已请求', claimed: '已领取', completed: '已完成', expired: '已过期', cancelled: '已取消' },
  activity: { title: '有边界的活动', commands: '命令', receipts: '凭证', notifications: '通知', artifacts: '屏幕工件', empty: '暂无记录。', workflow: '工作流', attempts: '投递次数', captured: '捕获时间', dimensions: '尺寸', removed: '已移除', active: '活动中', result: '结果' },
  errors: { load: 'Android 伴侣加载失败', pair: '创建配对码失败', revokeOffer: '撤销配对码失败', revokeDevice: '撤销 Android 伴侣失败' },
  success: { offer: '配对码已创建', revokeOffer: '配对码已撤销', revokeDevice: 'Android 伴侣已撤销' },
})

const zhTW = localized({ ...zh, title: 'Android 夥伴', subtitle: '統一管理加密 Android 執行、最小化觀察與持久驗證。', refresh: '重新整理', readOnly: '目前為唯讀權限；配對與撤銷裝置需要超級管理員。' })
const ja = localized({ title: 'Android コンパニオン', subtitle: '暗号化された Android 実行、最小化された観測、検証記録を管理します。', refresh: '更新', readOnly: '読み取り専用です。ペアリングと失効にはスーパー管理者が必要です。' })
const ko = localized({ title: 'Android 컴패니언', subtitle: '암호화된 Android 실행, 최소화된 관찰 및 검증 기록을 관리합니다.', refresh: '새로 고침', readOnly: '읽기 전용입니다. 페어링과 해지는 최고 관리자가 필요합니다.' })
const fr = localized({ title: 'Compagnon Android', subtitle: 'Exécution Android chiffrée, observations minimisées et vérification durable.', refresh: 'Actualiser', readOnly: 'Accès en lecture seule. Le jumelage et la révocation exigent un super-administrateur.' })
const es = localized({ title: 'Compañero Android', subtitle: 'Ejecución Android cifrada, observaciones minimizadas y verificación duradera.', refresh: 'Actualizar', readOnly: 'Acceso de solo lectura. El emparejamiento y la revocación requieren un superadministrador.' })
const de = localized({ title: 'Android-Begleiter', subtitle: 'Verschlüsselte Android-Ausführung, minimierte Beobachtungen und dauerhafte Verifikation.', refresh: 'Aktualisieren', readOnly: 'Nur Lesezugriff. Kopplung und Widerruf erfordern einen Superadministrator.' })
const pt = localized({ title: 'Companheiro Android', subtitle: 'Execução Android criptografada, observações minimizadas e verificação durável.', refresh: 'Atualizar', readOnly: 'Acesso somente leitura. Emparelhamento e revogação exigem um superadministrador.' })
const ru = localized({ title: 'Android-компаньон', subtitle: 'Зашифрованное выполнение Android, минимизированные наблюдения и проверяемые отчёты.', refresh: 'Обновить', readOnly: 'Доступ только для чтения. Для сопряжения и отзыва нужен суперадминистратор.' })

export const androidCompanionMessages = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru }
export const androidSystemMessages = {
  en: { title: 'Android Companion', summary: 'Encrypted device execution, minimized observations, receipts, and takeover.' },
  zh: { title: 'Android 伴侣', summary: '加密设备执行、最小化观察、凭证与人工接管。' },
  'zh-TW': { title: 'Android 夥伴', summary: '加密裝置執行、最小化觀察、憑證與人工接管。' },
  ja: { title: 'Android コンパニオン', summary: '暗号化された端末実行、最小化観測、証跡、手動対応。' },
  ko: { title: 'Android 컴패니언', summary: '암호화된 기기 실행, 최소화된 관찰, 영수증 및 사용자 개입.' },
  fr: { title: 'Compagnon Android', summary: 'Exécution chiffrée, observations minimisées, preuves et intervention.' },
  es: { title: 'Compañero Android', summary: 'Ejecución cifrada, observaciones minimizadas, comprobantes e intervención.' },
  de: { title: 'Android-Begleiter', summary: 'Verschlüsselte Ausführung, minimierte Beobachtungen, Belege und Übernahme.' },
  pt: { title: 'Companheiro Android', summary: 'Execução criptografada, observações minimizadas, comprovantes e intervenção.' },
  ru: { title: 'Android-компаньон', summary: 'Зашифрованное выполнение, минимальные наблюдения, отчёты и участие пользователя.' },
}
