const en = {
  title: 'Internet Execution Center', subtitle: 'Run bounded public-internet reads and keep a verified execution receipt.',
  refresh: 'Refresh', readOnly: 'You have read-only access. Submitting an internet intent requires a super administrator.',
  status: {
    kicker: 'Execution path', title: 'Provider readiness', ready: 'Ready', unavailable: 'Unavailable', provider: 'Provider',
    preferred: 'Preferred executor', fallback: 'Recovery executor', browser: 'Browser', verified: 'Verified receipts',
    receipts: '{count} total', loading: 'Loading provider state…', mcpFirst: 'MCP first.',
    mcpFirstSummary: 'Hermes uses the configured read-only semantic binding when it is healthy.',
    browserRecovery: 'Governed browser recovery.', browserRecoverySummary: 'Fallback stays on an allowlisted public origin and records proof.',
    runtimeIssue: 'Runtime attention required', stopped: 'Stopped', degraded: 'Degraded', healthy: 'Healthy', unknown: 'Unknown',
  },
  intent: {
    title: 'Public Bilibili read', summary: 'Submit a bounded search or inspect one exact BVID.', searchLabel: 'Search intent',
    searchPlaceholder: 'What do you want to find?', order: 'Order', relevance: 'Relevance', newest: 'Newest',
    mostViewed: 'Most viewed', limit: 'Limit', page: 'Page', search: 'Search', or: 'or inspect an exact video',
    bvidLabel: 'BVID', inspect: 'Inspect', runtimeUnavailable: 'No governed executor is currently available.',
    boundary: 'The server owns provider, target, executor selection, credentials, and verification.',
  },
  result: {
    title: 'Verified outcome', summary: 'Normalized public data and tamper-evident receipt proof.', executor: 'Executor',
    workflow: 'Workflow', digest: 'Result digest', evidence: 'Evidence', views: 'Views', duration: 'Duration',
    noDescription: 'No public description.', pending: 'The result is not verified yet.',
    empty: 'Submit an intent or select a recent receipt.', recent: 'Recent receipts', noReceipts: 'No internet receipts yet.',
  },
  workflow: {
    title: 'Execution workflow', refresh: 'Refresh', empty: 'No internet workflow selected.', state: 'State', attempt: 'Attempt',
    takeoverTitle: 'Human takeover required', takeoverSummary: 'Complete the visible challenge in the governed browser, then refresh this workflow.',
    takeoverPrivacy: 'Hermes does not receive or display your login secret.',
  },
  receiptStatus: {
    prepared: 'Prepared', executing: 'Executing', executed: 'Executed', verifying: 'Verifying', verified: 'Verified',
    unknown: 'Outcome unknown', mismatch: 'Verification mismatch', failed: 'Failed', waiting_user: 'Waiting for you',
  },
  workflowState: {
    draft: 'Draft', policy_check: 'Policy check', preparing: 'Preparing', executing: 'Executing', verifying: 'Verifying',
    waiting_user: 'Waiting for you', retrying: 'Retrying', compensating: 'Compensating', succeeded: 'Succeeded',
    denied: 'Denied', cancelled: 'Cancelled', failed: 'Failed', dead_letter: 'Needs review', compensated: 'Compensated',
  },
  errors: { load: 'Failed to load Internet Execution Center', execute: 'Internet intent failed' },
  success: { queued: 'Internet intent entered the governed workflow' },
}

type Messages = typeof en
type Overrides = Partial<Omit<Messages, 'status' | 'intent' | 'result' | 'workflow' | 'receiptStatus' | 'workflowState' | 'errors' | 'success'>> & {
  status?: Partial<Messages['status']>; intent?: Partial<Messages['intent']>; result?: Partial<Messages['result']>
  workflow?: Partial<Messages['workflow']>; receiptStatus?: Partial<Messages['receiptStatus']>
  workflowState?: Partial<Messages['workflowState']>; errors?: Partial<Messages['errors']>; success?: Partial<Messages['success']>
}
function localized(value: Overrides): Messages {
  return { ...en, ...value, status: { ...en.status, ...value.status }, intent: { ...en.intent, ...value.intent },
    result: { ...en.result, ...value.result }, workflow: { ...en.workflow, ...value.workflow },
    receiptStatus: { ...en.receiptStatus, ...value.receiptStatus }, workflowState: { ...en.workflowState, ...value.workflowState },
    errors: { ...en.errors, ...value.errors }, success: { ...en.success, ...value.success } }
}

const zh = localized({
  title: '互联网执行中心', subtitle: '执行有边界的公共互联网读取，并保留可验证的执行凭证。', refresh: '刷新',
  readOnly: '当前为只读权限，提交互联网意图需要超级管理员。',
  status: { kicker: '执行路径', title: 'Provider 就绪状态', ready: '已就绪', unavailable: '不可用', provider: 'Provider', preferred: '首选执行器', fallback: '恢复执行器', browser: '浏览器', verified: '已验证凭证', receipts: '共 {count} 条', loading: '正在加载 Provider 状态…', mcpFirst: 'MCP 优先。', mcpFirstSummary: '健康时使用已配置的只读语义绑定。', browserRecovery: '受治理的浏览器恢复。', browserRecoverySummary: '回退仅访问白名单公共来源并记录证据。', runtimeIssue: '运行时需要处理', stopped: '已停止', degraded: '降级', healthy: '健康', unknown: '未知' },
  intent: { title: 'Bilibili 公共读取', summary: '提交有边界的搜索，或检查一个明确的 BVID。', searchLabel: '搜索意图', searchPlaceholder: '你想查找什么？', order: '排序', relevance: '相关度', newest: '最新', mostViewed: '最多播放', limit: '条数', page: '页码', search: '搜索', or: '或检查指定视频', bvidLabel: 'BVID', inspect: '检查', runtimeUnavailable: '当前没有可用的受治理执行器。', boundary: 'Provider、目标、执行器选择、凭证和验证均由服务器持有。' },
  result: { title: '已验证结果', summary: '标准化公共数据与防篡改凭证。', executor: '执行器', workflow: '工作流', digest: '结果摘要', evidence: '证据', views: '播放量', duration: '时长', noDescription: '没有公开简介。', pending: '结果尚未验证。', empty: '提交意图或选择最近凭证。', recent: '最近凭证', noReceipts: '还没有互联网凭证。' },
  workflow: { title: '执行工作流', refresh: '刷新', empty: '尚未选择互联网工作流。', state: '状态', attempt: '尝试次数', takeoverTitle: '需要人工接管', takeoverSummary: '请在受治理浏览器中完成可见挑战，然后刷新此工作流。', takeoverPrivacy: 'Hermes 不会接收或展示你的登录秘密。' },
  receiptStatus: { prepared: '已准备', executing: '执行中', executed: '已执行', verifying: '验证中', verified: '已验证', unknown: '结果未知', mismatch: '验证不一致', failed: '失败', waiting_user: '等待你处理' },
  workflowState: { draft: '草稿', policy_check: '策略检查', preparing: '准备中', executing: '执行中', verifying: '验证中', waiting_user: '等待你处理', retrying: '重试中', compensating: '补偿中', succeeded: '成功', denied: '已拒绝', cancelled: '已取消', failed: '失败', dead_letter: '需要复核', compensated: '已补偿' },
  errors: { load: '互联网执行中心加载失败', execute: '互联网意图执行失败' }, success: { queued: '互联网意图已进入受治理工作流' },
})

const zhTW = localized({ ...zh, title: '網際網路執行中心', subtitle: '執行有邊界的公共網際網路讀取，並保留可驗證的執行憑證。', refresh: '重新整理', readOnly: '目前為唯讀權限，提交網際網路意圖需要超級管理員。',
  intent: { ...zh.intent, title: 'Bilibili 公共讀取', searchLabel: '搜尋意圖', searchPlaceholder: '你想尋找什麼？', search: '搜尋', inspect: '檢查' },
  result: { ...zh.result, title: '已驗證結果', recent: '最近憑證' }, workflow: { ...zh.workflow, refresh: '重新整理', takeoverTitle: '需要人工接管' } })

const ja = localized({ title: 'インターネット実行センター', subtitle: '範囲を限定した公開情報の読み取りと検証済み実行証跡を管理します。', refresh: '更新', readOnly: '読み取り専用です。実行にはスーパー管理者が必要です。',
  status: { title: 'プロバイダー準備状況', ready: '準備完了', unavailable: '利用不可', preferred: '優先実行系', fallback: '復旧実行系', browser: 'ブラウザー', verified: '検証済み証跡', mcpFirst: 'MCP を優先。', browserRecovery: '管理されたブラウザー復旧。', healthy: '正常', degraded: '低下', stopped: '停止', unknown: '不明' },
  intent: { title: 'Bilibili 公開情報の読み取り', summary: '限定検索または BVID の詳細確認を実行します。', searchLabel: '検索内容', searchPlaceholder: '何を探しますか？', order: '並び順', relevance: '関連度', newest: '新着', mostViewed: '再生数', limit: '件数', page: 'ページ', search: '検索', or: 'または動画を指定', inspect: '確認', runtimeUnavailable: '利用可能な管理対象実行系がありません。' },
  result: { title: '検証済み結果', executor: '実行系', workflow: 'ワークフロー', digest: '結果ダイジェスト', evidence: '証拠', views: '再生数', duration: '長さ', pending: '結果はまだ検証されていません。', empty: '実行するか最近の証跡を選択してください。', recent: '最近の証跡', noReceipts: '証跡はまだありません。' },
  workflow: { title: '実行ワークフロー', refresh: '更新', empty: 'ワークフローが選択されていません。', state: '状態', attempt: '試行', takeoverTitle: '手動操作が必要です', takeoverSummary: '管理されたブラウザーで表示中の確認を完了し、更新してください。' }, errors: { load: '実行センターを読み込めませんでした', execute: '実行に失敗しました' }, success: { queued: '管理ワークフローに追加しました' } })

const ko = localized({ title: '인터넷 실행 센터', subtitle: '범위가 제한된 공개 인터넷 조회와 검증된 실행 영수증을 관리합니다.', refresh: '새로 고침', readOnly: '읽기 전용입니다. 실행하려면 최고 관리자가 필요합니다.',
  status: { title: 'Provider 준비 상태', ready: '준비됨', unavailable: '사용 불가', preferred: '우선 실행기', fallback: '복구 실행기', browser: '브라우저', verified: '검증된 영수증', mcpFirst: 'MCP 우선.', browserRecovery: '관리형 브라우저 복구.', healthy: '정상', degraded: '저하', stopped: '중지', unknown: '알 수 없음' },
  intent: { title: 'Bilibili 공개 조회', summary: '제한된 검색 또는 정확한 BVID 조회를 실행합니다.', searchLabel: '검색 의도', searchPlaceholder: '무엇을 찾으시나요?', order: '정렬', relevance: '관련도', newest: '최신', mostViewed: '조회수', limit: '개수', page: '페이지', search: '검색', or: '또는 동영상 지정', inspect: '조회', runtimeUnavailable: '사용 가능한 관리형 실행기가 없습니다.' },
  result: { title: '검증된 결과', executor: '실행기', workflow: '워크플로', digest: '결과 다이제스트', evidence: '증거', views: '조회수', duration: '길이', pending: '아직 검증되지 않았습니다.', empty: '의도를 제출하거나 최근 영수증을 선택하세요.', recent: '최근 영수증', noReceipts: '영수증이 없습니다.' },
  workflow: { title: '실행 워크플로', refresh: '새로 고침', empty: '선택한 워크플로가 없습니다.', state: '상태', attempt: '시도', takeoverTitle: '사용자 조작 필요', takeoverSummary: '관리형 브라우저에서 표시된 확인을 완료한 뒤 새로 고치세요.' }, errors: { load: '실행 센터를 불러오지 못했습니다', execute: '실행에 실패했습니다' }, success: { queued: '관리형 워크플로에 등록했습니다' } })

const fr = localized({ title: "Centre d’exécution Internet", subtitle: 'Exécutez des lectures publiques limitées et conservez une preuve vérifiée.', refresh: 'Actualiser', readOnly: 'Accès en lecture seule. Un super-administrateur est requis pour exécuter.',
  status: { title: 'État du fournisseur', ready: 'Prêt', unavailable: 'Indisponible', preferred: 'Exécuteur principal', fallback: 'Exécuteur de reprise', browser: 'Navigateur', verified: 'Preuves vérifiées', mcpFirst: 'MCP en priorité.', browserRecovery: 'Reprise navigateur gouvernée.', healthy: 'Sain', degraded: 'Dégradé', stopped: 'Arrêté', unknown: 'Inconnu' },
  intent: { title: 'Lecture publique Bilibili', summary: 'Lancez une recherche limitée ou inspectez un BVID exact.', searchLabel: 'Recherche', searchPlaceholder: 'Que recherchez-vous ?', order: 'Tri', relevance: 'Pertinence', newest: 'Plus récent', mostViewed: 'Plus vu', limit: 'Limite', page: 'Page', search: 'Rechercher', or: 'ou inspecter une vidéo', inspect: 'Inspecter', runtimeUnavailable: "Aucun exécuteur gouverné n’est disponible." },
  result: { title: 'Résultat vérifié', executor: 'Exécuteur', workflow: 'Workflow', digest: 'Empreinte', evidence: 'Preuves', views: 'Vues', duration: 'Durée', pending: "Le résultat n’est pas encore vérifié.", empty: 'Lancez une requête ou choisissez une preuve récente.', recent: 'Preuves récentes', noReceipts: 'Aucune preuve Internet.' },
  workflow: { title: "Workflow d’exécution", refresh: 'Actualiser', empty: 'Aucun workflow sélectionné.', state: 'État', attempt: 'Tentative', takeoverTitle: 'Intervention humaine requise', takeoverSummary: 'Terminez le défi visible dans le navigateur gouverné, puis actualisez.' }, errors: { load: 'Échec du chargement du centre', execute: "Échec de l’exécution" }, success: { queued: 'Requête ajoutée au workflow gouverné' } })

const es = localized({ title: 'Centro de ejecución de Internet', subtitle: 'Ejecuta lecturas públicas acotadas y conserva un comprobante verificado.', refresh: 'Actualizar', readOnly: 'Acceso de solo lectura. Se requiere un superadministrador para ejecutar.',
  status: { title: 'Estado del proveedor', ready: 'Listo', unavailable: 'No disponible', preferred: 'Ejecutor preferido', fallback: 'Ejecutor de recuperación', browser: 'Navegador', verified: 'Comprobantes verificados', mcpFirst: 'MCP primero.', browserRecovery: 'Recuperación gobernada del navegador.', healthy: 'Correcto', degraded: 'Degradado', stopped: 'Detenido', unknown: 'Desconocido' },
  intent: { title: 'Lectura pública de Bilibili', summary: 'Envía una búsqueda acotada o inspecciona un BVID exacto.', searchLabel: 'Búsqueda', searchPlaceholder: '¿Qué quieres buscar?', order: 'Orden', relevance: 'Relevancia', newest: 'Más reciente', mostViewed: 'Más visto', limit: 'Límite', page: 'Página', search: 'Buscar', or: 'o inspeccionar un vídeo', inspect: 'Inspeccionar', runtimeUnavailable: 'No hay un ejecutor gobernado disponible.' },
  result: { title: 'Resultado verificado', executor: 'Ejecutor', workflow: 'Flujo', digest: 'Resumen', evidence: 'Evidencia', views: 'Vistas', duration: 'Duración', pending: 'El resultado aún no está verificado.', empty: 'Envía una intención o elige un comprobante reciente.', recent: 'Comprobantes recientes', noReceipts: 'No hay comprobantes.' },
  workflow: { title: 'Flujo de ejecución', refresh: 'Actualizar', empty: 'No hay flujo seleccionado.', state: 'Estado', attempt: 'Intento', takeoverTitle: 'Se requiere intervención humana', takeoverSummary: 'Completa el desafío visible en el navegador gobernado y actualiza.' }, errors: { load: 'No se pudo cargar el centro', execute: 'Falló la ejecución' }, success: { queued: 'Intención añadida al flujo gobernado' } })

const de = localized({ title: 'Internet-Ausführungszentrum', subtitle: 'Begrenzte öffentliche Abfragen mit verifiziertem Ausführungsbeleg.', refresh: 'Aktualisieren', readOnly: 'Nur Lesezugriff. Für die Ausführung ist ein Superadministrator erforderlich.',
  status: { title: 'Provider-Bereitschaft', ready: 'Bereit', unavailable: 'Nicht verfügbar', preferred: 'Bevorzugter Executor', fallback: 'Wiederherstellungs-Executor', browser: 'Browser', verified: 'Verifizierte Belege', mcpFirst: 'MCP zuerst.', browserRecovery: 'Gesteuerte Browser-Wiederherstellung.', healthy: 'Fehlerfrei', degraded: 'Eingeschränkt', stopped: 'Gestoppt', unknown: 'Unbekannt' },
  intent: { title: 'Öffentliche Bilibili-Abfrage', summary: 'Begrenzte Suche oder Prüfung einer exakten BVID.', searchLabel: 'Suchanfrage', searchPlaceholder: 'Wonach möchtest du suchen?', order: 'Sortierung', relevance: 'Relevanz', newest: 'Neueste', mostViewed: 'Meistgesehen', limit: 'Limit', page: 'Seite', search: 'Suchen', or: 'oder Video prüfen', inspect: 'Prüfen', runtimeUnavailable: 'Kein gesteuerter Executor verfügbar.' },
  result: { title: 'Verifiziertes Ergebnis', executor: 'Executor', workflow: 'Workflow', digest: 'Ergebnis-Digest', evidence: 'Nachweise', views: 'Aufrufe', duration: 'Dauer', pending: 'Das Ergebnis ist noch nicht verifiziert.', empty: 'Anfrage senden oder aktuellen Beleg wählen.', recent: 'Aktuelle Belege', noReceipts: 'Noch keine Belege.' },
  workflow: { title: 'Ausführungs-Workflow', refresh: 'Aktualisieren', empty: 'Kein Workflow ausgewählt.', state: 'Status', attempt: 'Versuch', takeoverTitle: 'Manuelle Übernahme erforderlich', takeoverSummary: 'Sichtbare Prüfung im gesteuerten Browser abschließen und aktualisieren.' }, errors: { load: 'Zentrum konnte nicht geladen werden', execute: 'Ausführung fehlgeschlagen' }, success: { queued: 'Anfrage in gesteuerten Workflow aufgenommen' } })

const pt = localized({ title: 'Central de execução da Internet', subtitle: 'Execute leituras públicas limitadas e guarde um comprovante verificado.', refresh: 'Atualizar', readOnly: 'Acesso somente leitura. É necessário um superadministrador para executar.',
  status: { title: 'Prontidão do provedor', ready: 'Pronto', unavailable: 'Indisponível', preferred: 'Executor preferencial', fallback: 'Executor de recuperação', browser: 'Navegador', verified: 'Comprovantes verificados', mcpFirst: 'MCP primeiro.', browserRecovery: 'Recuperação governada do navegador.', healthy: 'Saudável', degraded: 'Degradado', stopped: 'Parado', unknown: 'Desconhecido' },
  intent: { title: 'Leitura pública do Bilibili', summary: 'Envie uma busca limitada ou inspecione um BVID exato.', searchLabel: 'Busca', searchPlaceholder: 'O que você quer encontrar?', order: 'Ordem', relevance: 'Relevância', newest: 'Mais recente', mostViewed: 'Mais visto', limit: 'Limite', page: 'Página', search: 'Buscar', or: 'ou inspecionar um vídeo', inspect: 'Inspecionar', runtimeUnavailable: 'Nenhum executor governado está disponível.' },
  result: { title: 'Resultado verificado', executor: 'Executor', workflow: 'Fluxo', digest: 'Resumo', evidence: 'Evidência', views: 'Visualizações', duration: 'Duração', pending: 'O resultado ainda não foi verificado.', empty: 'Envie uma intenção ou selecione um comprovante recente.', recent: 'Comprovantes recentes', noReceipts: 'Nenhum comprovante.' },
  workflow: { title: 'Fluxo de execução', refresh: 'Atualizar', empty: 'Nenhum fluxo selecionado.', state: 'Estado', attempt: 'Tentativa', takeoverTitle: 'Intervenção humana necessária', takeoverSummary: 'Conclua o desafio visível no navegador governado e atualize.' }, errors: { load: 'Falha ao carregar a central', execute: 'Falha na execução' }, success: { queued: 'Intenção adicionada ao fluxo governado' } })

const ru = localized({ title: 'Центр интернет-операций', subtitle: 'Ограниченное чтение открытых данных с проверяемым отчётом выполнения.', refresh: 'Обновить', readOnly: 'Доступ только для чтения. Для запуска нужен суперадминистратор.',
  status: { title: 'Готовность провайдера', ready: 'Готово', unavailable: 'Недоступно', preferred: 'Основной исполнитель', fallback: 'Резервный исполнитель', browser: 'Браузер', verified: 'Проверенные отчёты', mcpFirst: 'Сначала MCP.', browserRecovery: 'Управляемое восстановление через браузер.', healthy: 'Исправно', degraded: 'Ограничено', stopped: 'Остановлено', unknown: 'Неизвестно' },
  intent: { title: 'Чтение открытых данных Bilibili', summary: 'Ограниченный поиск или проверка точного BVID.', searchLabel: 'Поиск', searchPlaceholder: 'Что вы хотите найти?', order: 'Сортировка', relevance: 'Релевантность', newest: 'Новые', mostViewed: 'Популярные', limit: 'Лимит', page: 'Страница', search: 'Найти', or: 'или проверить видео', inspect: 'Проверить', runtimeUnavailable: 'Нет доступного управляемого исполнителя.' },
  result: { title: 'Проверенный результат', executor: 'Исполнитель', workflow: 'Процесс', digest: 'Хеш результата', evidence: 'Доказательства', views: 'Просмотры', duration: 'Длительность', pending: 'Результат ещё не проверен.', empty: 'Отправьте запрос или выберите недавний отчёт.', recent: 'Недавние отчёты', noReceipts: 'Отчётов пока нет.' },
  workflow: { title: 'Процесс выполнения', refresh: 'Обновить', empty: 'Процесс не выбран.', state: 'Состояние', attempt: 'Попытка', takeoverTitle: 'Требуется участие пользователя', takeoverSummary: 'Завершите видимую проверку в управляемом браузере и обновите данные.' }, errors: { load: 'Не удалось загрузить центр', execute: 'Ошибка выполнения' }, success: { queued: 'Запрос добавлен в управляемый процесс' } })

export const internetExecutionMessages = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru }
export const internetSystemMessages = {
  en: { title: 'Internet Execution', summary: 'Governed public reads, verified results, and execution receipts.' },
  zh: { title: '互联网执行', summary: '受治理的公共读取、验证结果与执行凭证。' },
  'zh-TW': { title: '網際網路執行', summary: '受治理的公共讀取、驗證結果與執行憑證。' },
  ja: { title: 'インターネット実行', summary: '管理された公開情報の読み取り、検証結果、実行証跡。' },
  ko: { title: '인터넷 실행', summary: '관리형 공개 조회, 검증 결과 및 실행 영수증.' },
  fr: { title: 'Exécution Internet', summary: 'Lectures publiques gouvernées, résultats vérifiés et preuves.' },
  es: { title: 'Ejecución de Internet', summary: 'Lecturas públicas gobernadas, resultados verificados y comprobantes.' },
  de: { title: 'Internet-Ausführung', summary: 'Gesteuerte öffentliche Abfragen, verifizierte Ergebnisse und Belege.' },
  pt: { title: 'Execução da Internet', summary: 'Leituras públicas governadas, resultados verificados e comprovantes.' },
  ru: { title: 'Интернет-операции', summary: 'Управляемое чтение открытых данных, проверенные результаты и отчёты.' },
}
