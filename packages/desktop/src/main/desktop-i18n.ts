import { app } from 'electron'

type DesktopLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'fr' | 'es' | 'de' | 'pt'

type TranslationKey =
  | 'tray.show'
  | 'tray.hide'
  | 'tray.checkForUpdates'
  | 'tray.openAtLogin'
  | 'tray.quit'
  | 'update.upToDateTitle'
  | 'update.upToDateMessage'
  | 'update.checkingTitle'
  | 'update.checkingMessage'
  | 'update.currentVersion'
  | 'update.availableTitle'
  | 'update.availableMessage'
  | 'update.downloading'
  | 'update.readyTitle'
  | 'update.readyMessage'
  | 'update.readyDetail'
  | 'update.restartNow'
  | 'update.download'
  | 'update.later'
  | 'update.failedTitle'
  | 'update.failedMessage'
  | 'update.noUpdateInfoMessage'
  | 'update.packagedOnlyMessage'
  | 'common.ok'

const supportedLocales: DesktopLocale[] = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt']

const translations: Record<DesktopLocale, Record<TranslationKey, string>> = {
  en: {
    'tray.show': 'Show Hermes Studio',
    'tray.hide': 'Hide Hermes Studio',
    'tray.checkForUpdates': 'Check for Updates',
    'tray.openAtLogin': 'Open at Login',
    'tray.quit': 'Quit Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio is up to date.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'Checking for updates...',
    'update.currentVersion': 'Current version: {version}',
    'update.availableTitle': 'Update available',
    'update.availableMessage': 'Hermes Studio {version} is available.',
    'update.downloading': 'The update is downloading in the background.',
    'update.readyTitle': 'Update ready',
    'update.readyMessage': 'Hermes Studio {version} is ready to install.',
    'update.readyDetail': 'Restart now to apply the update, or it will be installed on next quit.',
    'update.restartNow': 'Restart now',
    'update.download': 'Download',
    'update.later': 'Later',
    'update.failedTitle': 'Update check failed',
    'update.failedMessage': 'Could not check for Hermes Studio updates.',
    'update.noUpdateInfoMessage': 'Update information is not available for this platform yet.',
    'update.packagedOnlyMessage': 'Automatic updates are only available in the packaged desktop app.',
    'common.ok': 'OK',
  },
  zh: {
    'tray.show': '显示 Hermes Studio',
    'tray.hide': '隐藏 Hermes Studio',
    'tray.checkForUpdates': '检查更新',
    'tray.openAtLogin': '开机启动',
    'tray.quit': '退出 Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio 已是最新版本。',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': '正在检查更新...',
    'update.currentVersion': '当前版本：{version}',
    'update.availableTitle': '发现新版本',
    'update.availableMessage': 'Hermes Studio {version} 可用。',
    'update.downloading': '更新正在后台下载。',
    'update.readyTitle': '更新已就绪',
    'update.readyMessage': 'Hermes Studio {version} 已准备好安装。',
    'update.readyDetail': '立即重启以应用更新，或下次退出时自动安装。',
    'update.restartNow': '立即重启',
    'update.download': '下载',
    'update.later': '稍后',
    'update.failedTitle': '检查更新失败',
    'update.failedMessage': '无法检查 Hermes Studio 更新。',
    'update.noUpdateInfoMessage': '当前平台的更新信息暂不可用。',
    'update.packagedOnlyMessage': '自动更新仅在打包后的桌面应用中可用。',
    'common.ok': '确定',
  },
  'zh-TW': {
    'tray.show': '顯示 Hermes Studio',
    'tray.hide': '隱藏 Hermes Studio',
    'tray.checkForUpdates': '檢查更新',
    'tray.openAtLogin': '開機啟動',
    'tray.quit': '結束 Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio 已是最新版本。',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': '正在檢查更新...',
    'update.currentVersion': '目前版本：{version}',
    'update.availableTitle': '發現新版本',
    'update.availableMessage': 'Hermes Studio {version} 可用。',
    'update.downloading': '更新正在背景下載。',
    'update.readyTitle': '更新已就緒',
    'update.readyMessage': 'Hermes Studio {version} 已準備好安裝。',
    'update.readyDetail': '立即重新啟動以套用更新，或下次結束時自動安裝。',
    'update.restartNow': '立即重新啟動',
    'update.download': '下載',
    'update.later': '稍後',
    'update.failedTitle': '檢查更新失敗',
    'update.failedMessage': '無法檢查 Hermes Studio 更新。',
    'update.noUpdateInfoMessage': '目前平台的更新資訊暫不可用。',
    'update.packagedOnlyMessage': '自動更新僅可在打包後的桌面應用中使用。',
    'common.ok': '確定',
  },
  ja: {
    'tray.show': 'Hermes Studio を表示',
    'tray.hide': 'Hermes Studio を隠す',
    'tray.checkForUpdates': 'アップデートを確認',
    'tray.openAtLogin': 'ログイン時に開く',
    'tray.quit': 'Hermes Studio を終了',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio は最新です。',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'アップデートを確認しています...',
    'update.currentVersion': '現在のバージョン: {version}',
    'update.availableTitle': 'アップデートがあります',
    'update.availableMessage': 'Hermes Studio {version} が利用できます。',
    'update.downloading': 'アップデートをバックグラウンドでダウンロードしています。',
    'update.readyTitle': 'アップデートの準備ができました',
    'update.readyMessage': 'Hermes Studio {version} をインストールできます。',
    'update.readyDetail': '今すぐ再起動して適用するか、次回終了時にインストールされます。',
    'update.restartNow': '今すぐ再起動',
    'update.download': 'ダウンロード',
    'update.later': '後で',
    'update.failedTitle': 'アップデート確認に失敗しました',
    'update.failedMessage': 'Hermes Studio のアップデートを確認できませんでした。',
    'update.noUpdateInfoMessage': 'このプラットフォームのアップデート情報はまだ利用できません。',
    'update.packagedOnlyMessage': '自動アップデートはパッケージ版デスクトップアプリでのみ利用できます。',
    'common.ok': 'OK',
  },
  ko: {
    'tray.show': 'Hermes Studio 표시',
    'tray.hide': 'Hermes Studio 숨기기',
    'tray.checkForUpdates': '업데이트 확인',
    'tray.openAtLogin': '로그인 시 열기',
    'tray.quit': 'Hermes Studio 종료',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio가 최신 버전입니다.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': '업데이트를 확인하는 중...',
    'update.currentVersion': '현재 버전: {version}',
    'update.availableTitle': '업데이트 사용 가능',
    'update.availableMessage': 'Hermes Studio {version}을 사용할 수 있습니다.',
    'update.downloading': '업데이트를 백그라운드에서 다운로드하고 있습니다.',
    'update.readyTitle': '업데이트 준비 완료',
    'update.readyMessage': 'Hermes Studio {version}을 설치할 준비가 되었습니다.',
    'update.readyDetail': '지금 다시 시작해 업데이트를 적용하거나 다음 종료 시 설치합니다.',
    'update.restartNow': '지금 다시 시작',
    'update.download': '다운로드',
    'update.later': '나중에',
    'update.failedTitle': '업데이트 확인 실패',
    'update.failedMessage': 'Hermes Studio 업데이트를 확인할 수 없습니다.',
    'update.noUpdateInfoMessage': '이 플랫폼의 업데이트 정보를 아직 사용할 수 없습니다.',
    'update.packagedOnlyMessage': '자동 업데이트는 패키징된 데스크톱 앱에서만 사용할 수 있습니다.',
    'common.ok': '확인',
  },
  fr: {
    'tray.show': 'Afficher Hermes Studio',
    'tray.hide': 'Masquer Hermes Studio',
    'tray.checkForUpdates': 'Rechercher les mises a jour',
    'tray.openAtLogin': 'Ouvrir a la connexion',
    'tray.quit': 'Quitter Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio est a jour.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'Recherche de mises a jour...',
    'update.currentVersion': 'Version actuelle : {version}',
    'update.availableTitle': 'Mise a jour disponible',
    'update.availableMessage': 'Hermes Studio {version} est disponible.',
    'update.downloading': 'La mise a jour se telecharge en arriere-plan.',
    'update.readyTitle': 'Mise a jour prete',
    'update.readyMessage': 'Hermes Studio {version} est pret a etre installe.',
    'update.readyDetail': 'Redemarrez maintenant pour appliquer la mise a jour, ou elle sera installee a la prochaine fermeture.',
    'update.restartNow': 'Redemarrer maintenant',
    'update.download': 'Telecharger',
    'update.later': 'Plus tard',
    'update.failedTitle': 'Echec de la recherche de mise a jour',
    'update.failedMessage': 'Impossible de rechercher les mises a jour de Hermes Studio.',
    'update.noUpdateInfoMessage': 'Les informations de mise a jour ne sont pas encore disponibles pour cette plateforme.',
    'update.packagedOnlyMessage': 'Les mises a jour automatiques ne sont disponibles que dans l application de bureau packagee.',
    'common.ok': 'OK',
  },
  es: {
    'tray.show': 'Mostrar Hermes Studio',
    'tray.hide': 'Ocultar Hermes Studio',
    'tray.checkForUpdates': 'Buscar actualizaciones',
    'tray.openAtLogin': 'Abrir al iniciar sesion',
    'tray.quit': 'Salir de Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio esta actualizado.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'Buscando actualizaciones...',
    'update.currentVersion': 'Version actual: {version}',
    'update.availableTitle': 'Actualizacion disponible',
    'update.availableMessage': 'Hermes Studio {version} esta disponible.',
    'update.downloading': 'La actualizacion se esta descargando en segundo plano.',
    'update.readyTitle': 'Actualizacion lista',
    'update.readyMessage': 'Hermes Studio {version} esta listo para instalarse.',
    'update.readyDetail': 'Reinicia ahora para aplicar la actualizacion, o se instalara al salir.',
    'update.restartNow': 'Reiniciar ahora',
    'update.download': 'Descargar',
    'update.later': 'Mas tarde',
    'update.failedTitle': 'Error al buscar actualizaciones',
    'update.failedMessage': 'No se pudieron buscar actualizaciones de Hermes Studio.',
    'update.noUpdateInfoMessage': 'La informacion de actualizacion aun no esta disponible para esta plataforma.',
    'update.packagedOnlyMessage': 'Las actualizaciones automaticas solo estan disponibles en la app de escritorio empaquetada.',
    'common.ok': 'Aceptar',
  },
  de: {
    'tray.show': 'Hermes Studio anzeigen',
    'tray.hide': 'Hermes Studio ausblenden',
    'tray.checkForUpdates': 'Nach Updates suchen',
    'tray.openAtLogin': 'Beim Anmelden offnen',
    'tray.quit': 'Hermes Studio beenden',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio ist auf dem neuesten Stand.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'Suche nach Updates...',
    'update.currentVersion': 'Aktuelle Version: {version}',
    'update.availableTitle': 'Update verfugbar',
    'update.availableMessage': 'Hermes Studio {version} ist verfugbar.',
    'update.downloading': 'Das Update wird im Hintergrund heruntergeladen.',
    'update.readyTitle': 'Update bereit',
    'update.readyMessage': 'Hermes Studio {version} ist zur Installation bereit.',
    'update.readyDetail': 'Jetzt neu starten, um das Update anzuwenden, oder es wird beim nachsten Beenden installiert.',
    'update.restartNow': 'Jetzt neu starten',
    'update.download': 'Herunterladen',
    'update.later': 'Spater',
    'update.failedTitle': 'Update-Prufung fehlgeschlagen',
    'update.failedMessage': 'Updates fur Hermes Studio konnten nicht gepruft werden.',
    'update.noUpdateInfoMessage': 'Update-Informationen sind fur diese Plattform noch nicht verfugbar.',
    'update.packagedOnlyMessage': 'Automatische Updates sind nur in der paketierten Desktop-App verfugbar.',
    'common.ok': 'OK',
  },
  pt: {
    'tray.show': 'Mostrar Hermes Studio',
    'tray.hide': 'Ocultar Hermes Studio',
    'tray.checkForUpdates': 'Verificar atualizacoes',
    'tray.openAtLogin': 'Abrir ao iniciar sessao',
    'tray.quit': 'Sair do Hermes Studio',
    'update.upToDateTitle': 'Hermes Studio',
    'update.upToDateMessage': 'Hermes Studio esta atualizado.',
    'update.checkingTitle': 'Hermes Studio',
    'update.checkingMessage': 'Verificando atualizacoes...',
    'update.currentVersion': 'Versao atual: {version}',
    'update.availableTitle': 'Atualizacao disponivel',
    'update.availableMessage': 'Hermes Studio {version} esta disponivel.',
    'update.downloading': 'A atualizacao esta sendo baixada em segundo plano.',
    'update.readyTitle': 'Atualizacao pronta',
    'update.readyMessage': 'Hermes Studio {version} esta pronto para instalar.',
    'update.readyDetail': 'Reinicie agora para aplicar a atualizacao, ou ela sera instalada ao sair.',
    'update.restartNow': 'Reiniciar agora',
    'update.download': 'Baixar',
    'update.later': 'Depois',
    'update.failedTitle': 'Falha ao verificar atualizacoes',
    'update.failedMessage': 'Nao foi possivel verificar atualizacoes do Hermes Studio.',
    'update.noUpdateInfoMessage': 'As informacoes de atualizacao ainda nao estao disponiveis para esta plataforma.',
    'update.packagedOnlyMessage': 'Atualizacoes automaticas estao disponiveis apenas no app desktop empacotado.',
    'common.ok': 'OK',
  },
}

function resolveLocale(): DesktopLocale {
  const tag = app.getLocale()
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) {
    return lower.includes('hant') || lower.includes('-tw') || lower.includes('-hk') || lower.includes('-mo')
      ? 'zh-TW'
      : 'zh'
  }

  const short = tag.slice(0, 2) as DesktopLocale
  return supportedLocales.includes(short) ? short : 'en'
}

export function t(key: TranslationKey, params: Record<string, string> = {}): string {
  const message = translations[resolveLocale()][key] || translations.en[key]
  return Object.entries(params).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement),
    message,
  )
}
