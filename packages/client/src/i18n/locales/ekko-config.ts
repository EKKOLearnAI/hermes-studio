const ekkoSettingsEn = {
  settingsTitle: 'Settings', settingsRuntime: 'Runtime', settingsModel: 'Model', settingsTools: 'Tools', settingsModules: 'Modules', settingsAdvanced: 'Advanced',
  noDefaultProvider: 'No default provider', authorized: 'Authorized', maxSteps: 'Maximum tool rounds', maxModelRetries: 'Model retries', maxToolFailures: 'Consecutive tool failure limit', backgroundDelegation: 'Background delegation', subtaskMaxSteps: 'Subtask tool rounds',
  defaultProvider: 'Default provider', defaultModel: 'Default model', requestTimeoutMs: 'Request timeout (ms)', temperature: 'Temperature', maxTokens: 'Maximum output tokens', reasoningEffort: 'Reasoning effort', reasoningSummary: 'Reasoning summary', authorizationLeewayMs: 'Authorization refresh leeway (ms)',
  toolsEnabled: 'Tools enabled', toolTimeoutMs: 'Tool timeout (ms)', approvalsEnabled: 'Tool approvals', approvalTimeoutMs: 'Approval timeout (ms)', permanentAllow: 'Permanently allowed tools', codeExecEnabled: 'Code execution', codeExecLanguages: 'Code execution languages', codeExecTimeoutMs: 'Code execution timeout (ms)', codeExecMaxCalls: 'Code execution tool-call limit', maxOutputBytes: 'Maximum output bytes', maxStderrBytes: 'Maximum stderr bytes', maxSourceBytes: 'Maximum source bytes',
  memoryEnabled: 'Memory enabled', recentMessageLimit: 'Recent message limit', recallTokenBudget: 'Automatic recall token budget', memorySearchLimit: 'Memory search result limit', memoryReviewInterval: 'Review every user messages', skillsEnabled: 'Skills enabled', skillReviewInterval: 'Review every tool calls', mcpEnabled: 'MCP enabled',
  logMaxBytes: 'Maximum log file bytes', promptInstructions: 'Global prompt instructions', schemaVersion: 'Config schema version', configPath: 'Config path',
}

type EkkoSettingsMessages = { [Key in keyof typeof ekkoSettingsEn]: string }

const ekkoSettingsZh = {
  settingsTitle: '设置', settingsRuntime: '运行', settingsModel: '模型', settingsTools: '工具', settingsModules: '模块', settingsAdvanced: '高级',
  noDefaultProvider: '不设默认 Provider', authorized: '已授权', maxSteps: '最大工具轮次', maxModelRetries: '模型重试次数', maxToolFailures: '连续工具失败上限', backgroundDelegation: '后台委派', subtaskMaxSteps: '子任务工具轮次',
  defaultProvider: '默认 Provider', defaultModel: '默认模型', requestTimeoutMs: '请求超时（毫秒）', temperature: 'Temperature', maxTokens: '最大输出 Token', reasoningEffort: '推理强度', reasoningSummary: '推理摘要', authorizationLeewayMs: '授权提前刷新时间（毫秒）',
  toolsEnabled: '启用工具', toolTimeoutMs: '工具超时（毫秒）', approvalsEnabled: '工具审批', approvalTimeoutMs: '审批超时（毫秒）', permanentAllow: '永久允许的工具', codeExecEnabled: '代码执行', codeExecLanguages: '代码执行语言', codeExecTimeoutMs: '代码执行超时（毫秒）', codeExecMaxCalls: '代码执行工具调用上限', maxOutputBytes: '最大输出字节数', maxStderrBytes: '最大错误输出字节数', maxSourceBytes: '最大源码字节数',
  memoryEnabled: '启用记忆', recentMessageLimit: '最近消息数量', recallTokenBudget: '自动召回 Token 预算', memorySearchLimit: '记忆搜索结果上限', memoryReviewInterval: '每隔多少条用户消息审核', skillsEnabled: '启用 Skills', skillReviewInterval: '每隔多少次工具调用检查 Skill', mcpEnabled: '启用 MCP',
  logMaxBytes: '日志文件最大字节数', promptInstructions: '全局 Prompt 指令', schemaVersion: '配置结构版本', configPath: '配置文件路径',
} satisfies EkkoSettingsMessages

const ekkoSettingsZhTw = {
  settingsTitle: '設定', settingsRuntime: '執行', settingsModel: '模型', settingsTools: '工具', settingsModules: '模組', settingsAdvanced: '進階',
  noDefaultProvider: '不設預設 Provider', authorized: '已授權', maxSteps: '最大工具輪次', maxModelRetries: '模型重試次數', maxToolFailures: '連續工具失敗上限', backgroundDelegation: '背景委派', subtaskMaxSteps: '子任務工具輪次',
  defaultProvider: '預設 Provider', defaultModel: '預設模型', requestTimeoutMs: '請求逾時（毫秒）', temperature: 'Temperature', maxTokens: '最大輸出 Token', reasoningEffort: '推理強度', reasoningSummary: '推理摘要', authorizationLeewayMs: '授權提前重新整理時間（毫秒）',
  toolsEnabled: '啟用工具', toolTimeoutMs: '工具逾時（毫秒）', approvalsEnabled: '工具審批', approvalTimeoutMs: '審批逾時（毫秒）', permanentAllow: '永久允許的工具', codeExecEnabled: '程式碼執行', codeExecLanguages: '程式碼執行語言', codeExecTimeoutMs: '程式碼執行逾時（毫秒）', codeExecMaxCalls: '程式碼執行工具呼叫上限', maxOutputBytes: '最大輸出位元組數', maxStderrBytes: '最大錯誤輸出位元組數', maxSourceBytes: '最大原始碼位元組數',
  memoryEnabled: '啟用記憶', recentMessageLimit: '最近訊息數量', recallTokenBudget: '自動召回 Token 預算', memorySearchLimit: '記憶搜尋結果上限', memoryReviewInterval: '每隔多少則使用者訊息審核', skillsEnabled: '啟用 Skills', skillReviewInterval: '每隔多少次工具呼叫檢查 Skill', mcpEnabled: '啟用 MCP',
  logMaxBytes: '日誌檔最大位元組數', promptInstructions: '全域 Prompt 指令', schemaVersion: '設定結構版本', configPath: '設定檔路徑',
} satisfies EkkoSettingsMessages

const ekkoSettingsDe = {
  settingsTitle: 'Einstellungen', settingsRuntime: 'Laufzeit', settingsModel: 'Modell', settingsTools: 'Tools', settingsModules: 'Module', settingsAdvanced: 'Erweitert',
  noDefaultProvider: 'Kein Standardanbieter', authorized: 'Autorisiert', maxSteps: 'Maximale Tool-Runden', maxModelRetries: 'Modellwiederholungen', maxToolFailures: 'Limit aufeinanderfolgender Tool-Fehler', backgroundDelegation: 'Hintergrunddelegierung', subtaskMaxSteps: 'Tool-Runden für Unteraufgaben',
  defaultProvider: 'Standardanbieter', defaultModel: 'Standardmodell', requestTimeoutMs: 'Anfrage-Timeout (ms)', temperature: 'Temperatur', maxTokens: 'Maximale Ausgabe-Token', reasoningEffort: 'Reasoning-Stärke', reasoningSummary: 'Reasoning-Zusammenfassung', authorizationLeewayMs: 'Vorlauf für Autorisierungsaktualisierung (ms)',
  toolsEnabled: 'Tools aktiviert', toolTimeoutMs: 'Tool-Timeout (ms)', approvalsEnabled: 'Tool-Genehmigungen', approvalTimeoutMs: 'Genehmigungs-Timeout (ms)', permanentAllow: 'Dauerhaft erlaubte Tools', codeExecEnabled: 'Codeausführung', codeExecLanguages: 'Sprachen für Codeausführung', codeExecTimeoutMs: 'Timeout der Codeausführung (ms)', codeExecMaxCalls: 'Tool-Aufruflimit der Codeausführung', maxOutputBytes: 'Maximale Ausgabebytes', maxStderrBytes: 'Maximale stderr-Bytes', maxSourceBytes: 'Maximale Quellcodebytes',
  memoryEnabled: 'Erinnerung aktiviert', recentMessageLimit: 'Limit letzter Nachrichten', recallTokenBudget: 'Token-Budget für automatischen Abruf', memorySearchLimit: 'Limit der Erinnerungssuche', memoryReviewInterval: 'Prüfung nach Benutzer-Nachrichten', skillsEnabled: 'Skills aktiviert', skillReviewInterval: 'Prüfung nach Tool-Aufrufen', mcpEnabled: 'MCP aktiviert',
  logMaxBytes: 'Maximale Logdateigröße in Bytes', promptInstructions: 'Globale Prompt-Anweisungen', schemaVersion: 'Konfigurationsschemaversion', configPath: 'Konfigurationspfad',
} satisfies EkkoSettingsMessages

const ekkoSettingsEs = {
  settingsTitle: 'Configuración', settingsRuntime: 'Ejecución', settingsModel: 'Modelo', settingsTools: 'Herramientas', settingsModules: 'Módulos', settingsAdvanced: 'Avanzado',
  noDefaultProvider: 'Sin proveedor predeterminado', authorized: 'Autorizado', maxSteps: 'Máximo de rondas de herramientas', maxModelRetries: 'Reintentos del modelo', maxToolFailures: 'Límite de fallos consecutivos', backgroundDelegation: 'Delegación en segundo plano', subtaskMaxSteps: 'Rondas de herramientas por subtarea',
  defaultProvider: 'Proveedor predeterminado', defaultModel: 'Modelo predeterminado', requestTimeoutMs: 'Tiempo límite de solicitud (ms)', temperature: 'Temperatura', maxTokens: 'Máximo de tokens de salida', reasoningEffort: 'Esfuerzo de razonamiento', reasoningSummary: 'Resumen de razonamiento', authorizationLeewayMs: 'Margen de renovación de autorización (ms)',
  toolsEnabled: 'Herramientas activadas', toolTimeoutMs: 'Tiempo límite de herramienta (ms)', approvalsEnabled: 'Aprobaciones de herramientas', approvalTimeoutMs: 'Tiempo límite de aprobación (ms)', permanentAllow: 'Herramientas permitidas permanentemente', codeExecEnabled: 'Ejecución de código', codeExecLanguages: 'Lenguajes de ejecución', codeExecTimeoutMs: 'Tiempo límite de ejecución (ms)', codeExecMaxCalls: 'Límite de llamadas desde código', maxOutputBytes: 'Máximo de bytes de salida', maxStderrBytes: 'Máximo de bytes de stderr', maxSourceBytes: 'Máximo de bytes de código fuente',
  memoryEnabled: 'Memoria activada', recentMessageLimit: 'Límite de mensajes recientes', recallTokenBudget: 'Presupuesto de tokens de recuperación', memorySearchLimit: 'Límite de resultados de memoria', memoryReviewInterval: 'Revisar cada mensajes de usuario', skillsEnabled: 'Skills activadas', skillReviewInterval: 'Revisar cada llamadas de herramienta', mcpEnabled: 'MCP activado',
  logMaxBytes: 'Máximo de bytes del archivo de registro', promptInstructions: 'Instrucciones globales del prompt', schemaVersion: 'Versión del esquema', configPath: 'Ruta de configuración',
} satisfies EkkoSettingsMessages

const ekkoSettingsFr = {
  settingsTitle: 'Paramètres', settingsRuntime: 'Exécution', settingsModel: 'Modèle', settingsTools: 'Outils', settingsModules: 'Modules', settingsAdvanced: 'Avancé',
  noDefaultProvider: 'Aucun fournisseur par défaut', authorized: 'Autorisé', maxSteps: 'Nombre maximal de tours d’outils', maxModelRetries: 'Nouvelles tentatives du modèle', maxToolFailures: 'Limite d’échecs consécutifs des outils', backgroundDelegation: 'Délégation en arrière-plan', subtaskMaxSteps: 'Tours d’outils des sous-tâches',
  defaultProvider: 'Fournisseur par défaut', defaultModel: 'Modèle par défaut', requestTimeoutMs: 'Délai de requête (ms)', temperature: 'Température', maxTokens: 'Nombre maximal de tokens de sortie', reasoningEffort: 'Effort de raisonnement', reasoningSummary: 'Résumé du raisonnement', authorizationLeewayMs: 'Marge de renouvellement de l’autorisation (ms)',
  toolsEnabled: 'Outils activés', toolTimeoutMs: 'Délai des outils (ms)', approvalsEnabled: 'Approbation des outils', approvalTimeoutMs: 'Délai d’approbation (ms)', permanentAllow: 'Outils toujours autorisés', codeExecEnabled: 'Exécution de code', codeExecLanguages: 'Langages d’exécution', codeExecTimeoutMs: 'Délai d’exécution du code (ms)', codeExecMaxCalls: 'Limite d’appels d’outils du code', maxOutputBytes: 'Octets de sortie maximum', maxStderrBytes: 'Octets stderr maximum', maxSourceBytes: 'Octets de source maximum',
  memoryEnabled: 'Mémoire activée', recentMessageLimit: 'Limite de messages récents', recallTokenBudget: 'Budget de tokens de rappel automatique', memorySearchLimit: 'Limite de résultats mémoire', memoryReviewInterval: 'Révision tous les messages utilisateur', skillsEnabled: 'Skills activés', skillReviewInterval: 'Révision tous les appels d’outils', mcpEnabled: 'MCP activé',
  logMaxBytes: 'Taille maximale du journal en octets', promptInstructions: 'Instructions globales du prompt', schemaVersion: 'Version du schéma de configuration', configPath: 'Chemin de configuration',
} satisfies EkkoSettingsMessages

const ekkoSettingsJa = {
  settingsTitle: '設定', settingsRuntime: 'ランタイム', settingsModel: 'モデル', settingsTools: 'ツール', settingsModules: 'モジュール', settingsAdvanced: '詳細',
  noDefaultProvider: '既定のプロバイダーなし', authorized: '認証済み', maxSteps: '最大ツールラウンド数', maxModelRetries: 'モデル再試行回数', maxToolFailures: '連続ツール失敗上限', backgroundDelegation: 'バックグラウンド委任', subtaskMaxSteps: 'サブタスクのツールラウンド数',
  defaultProvider: '既定のプロバイダー', defaultModel: '既定のモデル', requestTimeoutMs: 'リクエストタイムアウト（ms）', temperature: 'Temperature', maxTokens: '最大出力トークン数', reasoningEffort: '推論強度', reasoningSummary: '推論要約', authorizationLeewayMs: '認証更新の余裕時間（ms）',
  toolsEnabled: 'ツールを有効化', toolTimeoutMs: 'ツールタイムアウト（ms）', approvalsEnabled: 'ツール承認', approvalTimeoutMs: '承認タイムアウト（ms）', permanentAllow: '常に許可するツール', codeExecEnabled: 'コード実行', codeExecLanguages: 'コード実行言語', codeExecTimeoutMs: 'コード実行タイムアウト（ms）', codeExecMaxCalls: 'コード実行のツール呼び出し上限', maxOutputBytes: '最大出力バイト数', maxStderrBytes: '最大 stderr バイト数', maxSourceBytes: '最大ソースバイト数',
  memoryEnabled: 'メモリを有効化', recentMessageLimit: '直近メッセージ上限', recallTokenBudget: '自動想起トークン予算', memorySearchLimit: 'メモリ検索結果上限', memoryReviewInterval: 'ユーザーメッセージごとのレビュー間隔', skillsEnabled: 'スキルを有効化', skillReviewInterval: 'ツール呼び出しごとのスキル確認間隔', mcpEnabled: 'MCP を有効化',
  logMaxBytes: 'ログファイルの最大バイト数', promptInstructions: 'グローバル Prompt 指示', schemaVersion: '設定スキーマバージョン', configPath: '設定ファイルのパス',
} satisfies EkkoSettingsMessages

const ekkoSettingsKo = {
  settingsTitle: '설정', settingsRuntime: '런타임', settingsModel: '모델', settingsTools: '도구', settingsModules: '모듈', settingsAdvanced: '고급',
  noDefaultProvider: '기본 Provider 없음', authorized: '인증됨', maxSteps: '최대 도구 라운드', maxModelRetries: '모델 재시도 횟수', maxToolFailures: '연속 도구 실패 한도', backgroundDelegation: '백그라운드 위임', subtaskMaxSteps: '하위 작업 도구 라운드',
  defaultProvider: '기본 Provider', defaultModel: '기본 모델', requestTimeoutMs: '요청 시간 제한(ms)', temperature: 'Temperature', maxTokens: '최대 출력 토큰', reasoningEffort: '추론 강도', reasoningSummary: '추론 요약', authorizationLeewayMs: '인증 갱신 여유 시간(ms)',
  toolsEnabled: '도구 활성화', toolTimeoutMs: '도구 시간 제한(ms)', approvalsEnabled: '도구 승인', approvalTimeoutMs: '승인 시간 제한(ms)', permanentAllow: '항상 허용할 도구', codeExecEnabled: '코드 실행', codeExecLanguages: '코드 실행 언어', codeExecTimeoutMs: '코드 실행 시간 제한(ms)', codeExecMaxCalls: '코드 실행 도구 호출 한도', maxOutputBytes: '최대 출력 바이트', maxStderrBytes: '최대 stderr 바이트', maxSourceBytes: '최대 소스 바이트',
  memoryEnabled: '메모리 활성화', recentMessageLimit: '최근 메시지 한도', recallTokenBudget: '자동 회상 토큰 예산', memorySearchLimit: '메모리 검색 결과 한도', memoryReviewInterval: '사용자 메시지 검토 간격', skillsEnabled: '스킬 활성화', skillReviewInterval: '도구 호출별 스킬 확인 간격', mcpEnabled: 'MCP 활성화',
  logMaxBytes: '로그 파일 최대 바이트', promptInstructions: '전역 Prompt 지침', schemaVersion: '설정 스키마 버전', configPath: '설정 파일 경로',
} satisfies EkkoSettingsMessages

const ekkoSettingsPt = {
  settingsTitle: 'Configurações', settingsRuntime: 'Execução', settingsModel: 'Modelo', settingsTools: 'Ferramentas', settingsModules: 'Módulos', settingsAdvanced: 'Avançado',
  noDefaultProvider: 'Sem provedor padrão', authorized: 'Autorizado', maxSteps: 'Máximo de rodadas de ferramentas', maxModelRetries: 'Tentativas do modelo', maxToolFailures: 'Limite de falhas consecutivas', backgroundDelegation: 'Delegação em segundo plano', subtaskMaxSteps: 'Rodadas de ferramentas da subtarefa',
  defaultProvider: 'Provedor padrão', defaultModel: 'Modelo padrão', requestTimeoutMs: 'Tempo limite da solicitação (ms)', temperature: 'Temperatura', maxTokens: 'Máximo de tokens de saída', reasoningEffort: 'Esforço de raciocínio', reasoningSummary: 'Resumo do raciocínio', authorizationLeewayMs: 'Margem para renovar autorização (ms)',
  toolsEnabled: 'Ferramentas ativadas', toolTimeoutMs: 'Tempo limite da ferramenta (ms)', approvalsEnabled: 'Aprovações de ferramentas', approvalTimeoutMs: 'Tempo limite da aprovação (ms)', permanentAllow: 'Ferramentas sempre permitidas', codeExecEnabled: 'Execução de código', codeExecLanguages: 'Linguagens de execução', codeExecTimeoutMs: 'Tempo limite da execução (ms)', codeExecMaxCalls: 'Limite de chamadas da execução', maxOutputBytes: 'Máximo de bytes de saída', maxStderrBytes: 'Máximo de bytes de stderr', maxSourceBytes: 'Máximo de bytes do código-fonte',
  memoryEnabled: 'Memória ativada', recentMessageLimit: 'Limite de mensagens recentes', recallTokenBudget: 'Orçamento de tokens de recuperação', memorySearchLimit: 'Limite de resultados da memória', memoryReviewInterval: 'Revisar a cada mensagens do usuário', skillsEnabled: 'Skills ativadas', skillReviewInterval: 'Revisar a cada chamadas de ferramenta', mcpEnabled: 'MCP ativado',
  logMaxBytes: 'Máximo de bytes do arquivo de log', promptInstructions: 'Instruções globais do prompt', schemaVersion: 'Versão do esquema', configPath: 'Caminho da configuração',
} satisfies EkkoSettingsMessages

const ekkoSettingsRu = {
  settingsTitle: 'Настройки', settingsRuntime: 'Выполнение', settingsModel: 'Модель', settingsTools: 'Инструменты', settingsModules: 'Модули', settingsAdvanced: 'Расширенные',
  noDefaultProvider: 'Без провайдера по умолчанию', authorized: 'Авторизован', maxSteps: 'Максимум раундов инструментов', maxModelRetries: 'Повторы модели', maxToolFailures: 'Лимит последовательных ошибок', backgroundDelegation: 'Фоновое делегирование', subtaskMaxSteps: 'Раунды инструментов подзадачи',
  defaultProvider: 'Провайдер по умолчанию', defaultModel: 'Модель по умолчанию', requestTimeoutMs: 'Тайм-аут запроса (мс)', temperature: 'Температура', maxTokens: 'Максимум выходных токенов', reasoningEffort: 'Интенсивность рассуждения', reasoningSummary: 'Сводка рассуждения', authorizationLeewayMs: 'Запас обновления авторизации (мс)',
  toolsEnabled: 'Инструменты включены', toolTimeoutMs: 'Тайм-аут инструмента (мс)', approvalsEnabled: 'Подтверждение инструментов', approvalTimeoutMs: 'Тайм-аут подтверждения (мс)', permanentAllow: 'Всегда разрешённые инструменты', codeExecEnabled: 'Выполнение кода', codeExecLanguages: 'Языки выполнения кода', codeExecTimeoutMs: 'Тайм-аут выполнения кода (мс)', codeExecMaxCalls: 'Лимит вызовов из кода', maxOutputBytes: 'Максимум байтов вывода', maxStderrBytes: 'Максимум байтов stderr', maxSourceBytes: 'Максимум байтов исходного кода',
  memoryEnabled: 'Память включена', recentMessageLimit: 'Лимит последних сообщений', recallTokenBudget: 'Бюджет токенов автопоиска', memorySearchLimit: 'Лимит результатов памяти', memoryReviewInterval: 'Проверка через сообщения пользователя', skillsEnabled: 'Навыки включены', skillReviewInterval: 'Проверка через вызовы инструментов', mcpEnabled: 'MCP включён',
  logMaxBytes: 'Максимальный размер журнала в байтах', promptInstructions: 'Глобальные инструкции Prompt', schemaVersion: 'Версия схемы конфигурации', configPath: 'Путь к конфигурации',
} satisfies EkkoSettingsMessages

const ekkoSettingsAr = {
  settingsTitle: 'الإعدادات', settingsRuntime: 'التشغيل', settingsModel: 'النموذج', settingsTools: 'الأدوات', settingsModules: 'الوحدات', settingsAdvanced: 'متقدم',
  noDefaultProvider: 'لا يوجد مزود افتراضي', authorized: 'مصرّح', maxSteps: 'الحد الأقصى لجولات الأدوات', maxModelRetries: 'إعادات محاولة النموذج', maxToolFailures: 'حد إخفاقات الأدوات المتتالية', backgroundDelegation: 'التفويض في الخلفية', subtaskMaxSteps: 'جولات أدوات المهمة الفرعية',
  defaultProvider: 'المزود الافتراضي', defaultModel: 'النموذج الافتراضي', requestTimeoutMs: 'مهلة الطلب (مللي ثانية)', temperature: 'درجة الحرارة', maxTokens: 'الحد الأقصى لرموز الإخراج', reasoningEffort: 'مستوى الاستدلال', reasoningSummary: 'ملخص الاستدلال', authorizationLeewayMs: 'هامش تحديث التفويض (مللي ثانية)',
  toolsEnabled: 'تمكين الأدوات', toolTimeoutMs: 'مهلة الأداة (مللي ثانية)', approvalsEnabled: 'موافقات الأدوات', approvalTimeoutMs: 'مهلة الموافقة (مللي ثانية)', permanentAllow: 'الأدوات المسموح بها دائمًا', codeExecEnabled: 'تنفيذ الشفرة', codeExecLanguages: 'لغات تنفيذ الشفرة', codeExecTimeoutMs: 'مهلة تنفيذ الشفرة (مللي ثانية)', codeExecMaxCalls: 'حد استدعاءات الأدوات من الشفرة', maxOutputBytes: 'الحد الأقصى لبايتات الإخراج', maxStderrBytes: 'الحد الأقصى لبايتات stderr', maxSourceBytes: 'الحد الأقصى لبايتات المصدر',
  memoryEnabled: 'تمكين الذاكرة', recentMessageLimit: 'حد الرسائل الأخيرة', recallTokenBudget: 'ميزانية رموز الاستدعاء التلقائي', memorySearchLimit: 'حد نتائج بحث الذاكرة', memoryReviewInterval: 'المراجعة كل عدد من رسائل المستخدم', skillsEnabled: 'تمكين المهارات', skillReviewInterval: 'المراجعة كل عدد من استدعاءات الأدوات', mcpEnabled: 'تمكين MCP',
  logMaxBytes: 'الحد الأقصى لبايتات ملف السجل', promptInstructions: 'تعليمات Prompt العامة', schemaVersion: 'إصدار مخطط الإعدادات', configPath: 'مسار ملف الإعدادات',
} satisfies EkkoSettingsMessages

const ekkoSettingHintsEn = {
  featureToggleHint: 'Controls whether this capability is available to Ekko.',
  runLimitHint: 'Caps work in a single run; execution stops when the limit is reached.',
  retryLimitHint: 'Maximum automatic retries after a model request fails.',
  failureLimitHint: 'Stops the run after this many consecutive tool failures.',
  timeoutHint: 'Aborts the corresponding request or operation after this duration.',
  modelParameterHint: 'Sent with model requests to control response generation and reasoning.',
  authorizationLeewayHint: 'Refreshes authorization this long before it expires.',
  allowlistHint: 'These tools can run without asking for approval again.',
  languagesHint: 'Restricts which runtimes the code execution tool may use.',
  outputSizeHint: 'Limits generated data to prevent oversized execution results.',
  memoryWindowHint: 'Number of recent messages retained when preparing memory context.',
  recallBudgetHint: 'Maximum tokens reserved for automatically recalled memories.',
  resultLimitHint: 'Maximum memory records returned by one search.',
  reviewIntervalHint: 'Runs an automatic review whenever this activity count is reached.',
  promptInstructionsHint: 'Extra instructions appended to every Ekko run.',
  readonlyConfigHint: 'Read-only metadata for the active Ekko configuration.',
}

type EkkoSettingHintMessages = { [Key in keyof typeof ekkoSettingHintsEn]: string }

const ekkoSettingHintsZh = {
  featureToggleHint: '控制 Ekko 是否可以使用这项能力。',
  runLimitHint: '限制单次运行的工作量；达到上限后结束继续执行。',
  retryLimitHint: '模型请求失败后自动重试的最大次数。',
  failureLimitHint: '工具连续失败达到该次数后停止当前运行。',
  timeoutHint: '对应请求或操作超过该时长后自动中止。',
  modelParameterHint: '随模型请求发送，用于控制回复生成和推理行为。',
  authorizationLeewayHint: '在授权过期前提前这段时间进行刷新。',
  allowlistHint: '列表中的工具再次运行时无需请求审批。',
  languagesHint: '限制代码执行工具可以使用的运行时语言。',
  outputSizeHint: '限制生成数据大小，避免执行结果过大。',
  memoryWindowHint: '准备记忆上下文时保留的最近消息数量。',
  recallBudgetHint: '自动召回并注入记忆时最多占用的 Token。',
  resultLimitHint: '单次记忆搜索最多返回的记录数量。',
  reviewIntervalHint: '相关活动达到该次数时触发一次自动审核。',
  promptInstructionsHint: '附加到每次 Ekko 运行中的额外指令。',
  readonlyConfigHint: '当前 Ekko 配置的只读元数据。',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsZhTw = {
  featureToggleHint: '控制 Ekko 是否可以使用這項能力。',
  runLimitHint: '限制單次執行的工作量；達到上限後停止繼續執行。',
  retryLimitHint: '模型請求失敗後自動重試的最大次數。',
  failureLimitHint: '工具連續失敗達到此次數後停止目前執行。',
  timeoutHint: '對應請求或操作超過此時長後自動中止。',
  modelParameterHint: '隨模型請求傳送，用於控制回覆產生與推理行為。',
  authorizationLeewayHint: '在授權到期前提前這段時間進行重新整理。',
  allowlistHint: '清單中的工具再次執行時無需請求審批。',
  languagesHint: '限制程式碼執行工具可以使用的執行環境語言。',
  outputSizeHint: '限制產生資料大小，避免執行結果過大。',
  memoryWindowHint: '準備記憶上下文時保留的最近訊息數量。',
  recallBudgetHint: '自動召回並注入記憶時最多占用的 Token。',
  resultLimitHint: '單次記憶搜尋最多回傳的記錄數量。',
  reviewIntervalHint: '相關活動達到此次數時觸發一次自動審核。',
  promptInstructionsHint: '附加到每次 Ekko 執行中的額外指令。',
  readonlyConfigHint: '目前 Ekko 設定的唯讀中繼資料。',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsDe = {
  featureToggleHint: 'Steuert, ob diese Funktion für Ekko verfügbar ist.',
  runLimitHint: 'Begrenzt die Arbeit pro Lauf; beim Erreichen des Limits wird die Ausführung beendet.',
  retryLimitHint: 'Maximale automatische Wiederholungen nach einer fehlgeschlagenen Modellanfrage.',
  failureLimitHint: 'Beendet den Lauf nach dieser Anzahl aufeinanderfolgender Tool-Fehler.',
  timeoutHint: 'Bricht die zugehörige Anfrage oder Aktion nach dieser Dauer ab.',
  modelParameterHint: 'Wird mit Modellanfragen gesendet und steuert Generierung und Reasoning.',
  authorizationLeewayHint: 'Aktualisiert die Autorisierung um diese Zeit vor ihrem Ablauf.',
  allowlistHint: 'Diese Tools können ohne erneute Genehmigung ausgeführt werden.',
  languagesHint: 'Beschränkt die Laufzeiten, die das Codeausführungs-Tool verwenden darf.',
  outputSizeHint: 'Begrenzt erzeugte Daten, damit Ausführungsergebnisse nicht zu groß werden.',
  memoryWindowHint: 'Anzahl letzter Nachrichten, die für den Erinnerungskontext erhalten bleiben.',
  recallBudgetHint: 'Maximale Tokenzahl für automatisch abgerufene Erinnerungen.',
  resultLimitHint: 'Maximale Anzahl von Erinnerungen pro Suche.',
  reviewIntervalHint: 'Startet eine automatische Prüfung, sobald diese Aktivitätszahl erreicht ist.',
  promptInstructionsHint: 'Zusätzliche Anweisungen für jeden Lauf von Ekko.',
  readonlyConfigHint: 'Schreibgeschützte Metadaten der aktiven Ekko-Konfiguration.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsEs = {
  featureToggleHint: 'Controla si esta capacidad está disponible para Ekko.',
  runLimitHint: 'Limita el trabajo de una ejecución; se detiene al alcanzar el límite.',
  retryLimitHint: 'Máximo de reintentos automáticos tras fallar una solicitud al modelo.',
  failureLimitHint: 'Detiene la ejecución tras este número de fallos consecutivos de herramientas.',
  timeoutHint: 'Cancela la solicitud u operación correspondiente después de este tiempo.',
  modelParameterHint: 'Se envía al modelo para controlar la generación y el razonamiento.',
  authorizationLeewayHint: 'Renueva la autorización este tiempo antes de que caduque.',
  allowlistHint: 'Estas herramientas pueden ejecutarse sin volver a solicitar aprobación.',
  languagesHint: 'Limita los entornos que puede usar la herramienta de ejecución de código.',
  outputSizeHint: 'Limita los datos generados para evitar resultados demasiado grandes.',
  memoryWindowHint: 'Cantidad de mensajes recientes conservados para preparar el contexto de memoria.',
  recallBudgetHint: 'Máximo de tokens reservado para recuerdos recuperados automáticamente.',
  resultLimitHint: 'Máximo de registros de memoria devueltos por búsqueda.',
  reviewIntervalHint: 'Ejecuta una revisión automática al alcanzar esta cantidad de actividad.',
  promptInstructionsHint: 'Instrucciones adicionales incluidas en cada ejecución de Ekko.',
  readonlyConfigHint: 'Metadatos de solo lectura de la configuración activa de Ekko.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsFr = {
  featureToggleHint: 'Détermine si cette fonctionnalité est disponible pour Ekko.',
  runLimitHint: 'Limite le travail par exécution ; celle-ci s’arrête lorsque la limite est atteinte.',
  retryLimitHint: 'Nombre maximal de nouvelles tentatives après l’échec d’une requête au modèle.',
  failureLimitHint: 'Arrête l’exécution après ce nombre d’échecs consécutifs des outils.',
  timeoutHint: 'Interrompt la requête ou l’opération correspondante après cette durée.',
  modelParameterHint: 'Envoyé au modèle pour contrôler la génération et le raisonnement.',
  authorizationLeewayHint: 'Actualise l’autorisation cette durée avant son expiration.',
  allowlistHint: 'Ces outils peuvent être exécutés sans demander une nouvelle approbation.',
  languagesHint: 'Limite les environnements utilisables par l’outil d’exécution de code.',
  outputSizeHint: 'Limite les données générées pour éviter des résultats trop volumineux.',
  memoryWindowHint: 'Nombre de messages récents conservés pour préparer le contexte mémoire.',
  recallBudgetHint: 'Nombre maximal de tokens réservé aux souvenirs rappelés automatiquement.',
  resultLimitHint: 'Nombre maximal de souvenirs renvoyés par une recherche.',
  reviewIntervalHint: 'Lance une vérification automatique lorsque ce nombre d’activités est atteint.',
  promptInstructionsHint: 'Instructions supplémentaires ajoutées à chaque exécution d’Ekko.',
  readonlyConfigHint: 'Métadonnées en lecture seule de la configuration Ekko active.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsJa = {
  featureToggleHint: 'この機能を Ekko で使用できるかどうかを制御します。',
  runLimitHint: '1 回の実行量を制限し、上限に達すると実行を終了します。',
  retryLimitHint: 'モデルリクエスト失敗後の自動再試行回数の上限です。',
  failureLimitHint: 'ツールがこの回数連続で失敗すると現在の実行を停止します。',
  timeoutHint: '対応するリクエストまたは操作をこの時間後に中止します。',
  modelParameterHint: 'モデルへ送信され、応答生成と推論動作を制御します。',
  authorizationLeewayHint: '認証の期限が切れるこの時間前に更新します。',
  allowlistHint: '一覧のツールは再度承認を求めずに実行できます。',
  languagesHint: 'コード実行ツールが使用できるランタイムを制限します。',
  outputSizeHint: '生成データを制限し、実行結果が大きくなりすぎるのを防ぎます。',
  memoryWindowHint: 'メモリコンテキストの準備時に保持する直近メッセージ数です。',
  recallBudgetHint: '自動的に想起されるメモリに使用できる最大トークン数です。',
  resultLimitHint: '1 回の検索で返すメモリ件数の上限です。',
  reviewIntervalHint: '関連する操作がこの回数に達するたびに自動確認を行います。',
  promptInstructionsHint: 'Ekko の各実行に追加される指示です。',
  readonlyConfigHint: '現在の Ekko 設定に関する読み取り専用メタデータです。',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsKo = {
  featureToggleHint: 'Ekko에서 이 기능을 사용할 수 있는지 제어합니다.',
  runLimitHint: '한 번의 실행 작업량을 제한하며 한도에 도달하면 실행을 종료합니다.',
  retryLimitHint: '모델 요청 실패 후 자동 재시도하는 최대 횟수입니다.',
  failureLimitHint: '도구가 이 횟수만큼 연속 실패하면 현재 실행을 중지합니다.',
  timeoutHint: '해당 요청이나 작업이 이 시간을 넘으면 중단합니다.',
  modelParameterHint: '모델 요청과 함께 전송되어 응답 생성과 추론을 제어합니다.',
  authorizationLeewayHint: '인증이 만료되기 이 시간 전에 갱신합니다.',
  allowlistHint: '목록의 도구는 다시 승인을 요청하지 않고 실행할 수 있습니다.',
  languagesHint: '코드 실행 도구가 사용할 수 있는 런타임을 제한합니다.',
  outputSizeHint: '생성 데이터 크기를 제한하여 실행 결과가 너무 커지는 것을 방지합니다.',
  memoryWindowHint: '메모리 컨텍스트를 준비할 때 유지할 최근 메시지 수입니다.',
  recallBudgetHint: '자동으로 불러온 메모리에 사용할 최대 토큰 수입니다.',
  resultLimitHint: '한 번의 검색에서 반환할 최대 메모리 레코드 수입니다.',
  reviewIntervalHint: '관련 활동이 이 횟수에 도달할 때마다 자동 검토를 실행합니다.',
  promptInstructionsHint: '모든 Ekko 실행에 추가되는 지침입니다.',
  readonlyConfigHint: '현재 Ekko 설정의 읽기 전용 메타데이터입니다.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsPt = {
  featureToggleHint: 'Controla se este recurso está disponível para o Ekko.',
  runLimitHint: 'Limita o trabalho por execução; ela termina quando o limite é atingido.',
  retryLimitHint: 'Máximo de novas tentativas automáticas após uma solicitação ao modelo falhar.',
  failureLimitHint: 'Encerra a execução após este número de falhas consecutivas de ferramentas.',
  timeoutHint: 'Interrompe a solicitação ou operação correspondente após este período.',
  modelParameterHint: 'Enviado ao modelo para controlar a geração da resposta e o raciocínio.',
  authorizationLeewayHint: 'Renova a autorização este tempo antes de ela expirar.',
  allowlistHint: 'Estas ferramentas podem ser executadas sem solicitar nova aprovação.',
  languagesHint: 'Limita os runtimes que a ferramenta de execução de código pode usar.',
  outputSizeHint: 'Limita os dados gerados para evitar resultados de execução muito grandes.',
  memoryWindowHint: 'Quantidade de mensagens recentes mantidas ao preparar o contexto de memória.',
  recallBudgetHint: 'Máximo de tokens reservado para memórias recuperadas automaticamente.',
  resultLimitHint: 'Máximo de registros de memória retornados por pesquisa.',
  reviewIntervalHint: 'Executa uma revisão automática quando esta contagem de atividade é atingida.',
  promptInstructionsHint: 'Instruções extras adicionadas a cada execução do Ekko.',
  readonlyConfigHint: 'Metadados somente leitura da configuração ativa do Ekko.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsRu = {
  featureToggleHint: 'Определяет, доступна ли эта возможность агенту Ekko.',
  runLimitHint: 'Ограничивает работу за один запуск; при достижении лимита выполнение прекращается.',
  retryLimitHint: 'Максимальное число автоматических повторов после ошибки запроса к модели.',
  failureLimitHint: 'Останавливает запуск после указанного числа последовательных ошибок инструментов.',
  timeoutHint: 'Прерывает соответствующий запрос или операцию по истечении этого времени.',
  modelParameterHint: 'Передаётся модели и управляет генерацией ответа и рассуждением.',
  authorizationLeewayHint: 'Обновляет авторизацию за указанное время до истечения срока.',
  allowlistHint: 'Эти инструменты могут запускаться без повторного запроса подтверждения.',
  languagesHint: 'Ограничивает среды, доступные инструменту выполнения кода.',
  outputSizeHint: 'Ограничивает создаваемые данные, предотвращая слишком большие результаты.',
  memoryWindowHint: 'Число последних сообщений, сохраняемых при подготовке контекста памяти.',
  recallBudgetHint: 'Максимальное число токенов для автоматически найденных воспоминаний.',
  resultLimitHint: 'Максимальное число записей памяти в одном результате поиска.',
  reviewIntervalHint: 'Запускает автоматическую проверку при достижении этого числа действий.',
  promptInstructionsHint: 'Дополнительные инструкции для каждого запуска агента Ekko.',
  readonlyConfigHint: 'Метаданные активной конфигурации Ekko, доступные только для чтения.',
} satisfies EkkoSettingHintMessages

const ekkoSettingHintsAr = {
  featureToggleHint: 'يتحكم في إتاحة هذه الإمكانية لوكيل Ekko.',
  runLimitHint: 'يحد من العمل في التشغيل الواحد؛ ويتوقف التنفيذ عند بلوغ الحد.',
  retryLimitHint: 'الحد الأقصى لإعادات المحاولة التلقائية بعد فشل طلب النموذج.',
  failureLimitHint: 'يوقف التشغيل بعد هذا العدد من إخفاقات الأدوات المتتالية.',
  timeoutHint: 'يلغي الطلب أو العملية المقابلة بعد انقضاء هذه المدة.',
  modelParameterHint: 'يُرسل إلى النموذج للتحكم في إنشاء الرد والاستدلال.',
  authorizationLeewayHint: 'يحدّث التفويض قبل انتهاء صلاحيته بهذه المدة.',
  allowlistHint: 'يمكن تشغيل هذه الأدوات دون طلب الموافقة مرة أخرى.',
  languagesHint: 'يقيّد بيئات التشغيل التي يمكن لأداة تنفيذ الشفرة استخدامها.',
  outputSizeHint: 'يحد من البيانات الناتجة لتجنب نتائج تنفيذ كبيرة جدًا.',
  memoryWindowHint: 'عدد الرسائل الأخيرة المحتفظ بها عند إعداد سياق الذاكرة.',
  recallBudgetHint: 'الحد الأقصى للرموز المخصصة للذكريات المستدعاة تلقائيًا.',
  resultLimitHint: 'الحد الأقصى لسجلات الذاكرة التي يعيدها البحث الواحد.',
  reviewIntervalHint: 'يشغّل مراجعة تلقائية عند بلوغ هذا العدد من الأنشطة.',
  promptInstructionsHint: 'تعليمات إضافية تُلحق بكل تشغيل لوكيل Ekko.',
  readonlyConfigHint: 'بيانات وصفية للقراءة فقط لإعدادات Ekko النشطة.',
} satisfies EkkoSettingHintMessages

export const ekkoConfigEn = {
  ...ekkoSettingsEn,
  ...ekkoSettingHintsEn,
  back: 'Back',
  refresh: 'Refresh',
  loadFailed: 'Failed to load Ekko configuration',
  deleted: 'Deleted',
  allStatuses: 'All statuses',
  statusActive: 'Active',
  statusSuperseded: 'Superseded',
  statusExpired: 'Expired',
  statusDeleted: 'Deleted',
  memoryTitle: 'Memory',
  memoryDescription: 'Review and maintain durable memories for the active Profile.',
  searchMemory: 'Search memory title or content…',
  noMemory: 'No matching memories',
  graphView: 'Graph',
  listView: 'List',
  memoryNodes: 'nodes',
  memoryRelations: 'relations',
  relationRevision: 'Version history',
  relationSource: 'Same source',
  relationEntity: 'Shared entity',
  relatedMemories: 'Related memories',
  noRelations: 'No direct relationships',
  memoryKey: 'Memory key',
  memoryCategory: 'Category',
  memoryEntities: 'Entities',
  memoryUpdatedAt: 'Updated',
  memoryScope: 'Scope',
  memoryRevision: 'Revision',
  memoryConfidence: 'Confidence',
  memoryImportance: 'Importance',
  memoryGraphHint: 'Select a node to inspect its content and relationships.',
  editMemory: 'Edit memory',
  deleteMemoryConfirm: 'Soft-delete this memory?',
  titleLabel: 'Title',
  contentLabel: 'Content',
  tagsLabel: 'Tags',
  tagsPlaceholder: 'Comma-separated tags',
  skillsTitle: 'Ekko Skills',
  skillsDescription: 'Create and edit the reusable instructions available to Ekko.',
  newSkill: 'New skill',
  searchSkills: 'Search skills…',
  noSkills: 'No matching skills',
  selectSkill: 'Select a skill or create a new one',
  skillName: 'Skill name',
  skillContent: 'SKILL.md',
  skillFormatHint: 'SKILL.md must include YAML frontmatter with matching name, description, and compact English metadata.keywords fields.',
  skillTemplateDescription: 'Describe when Ekko should use this skill.',
  skillTemplateBody: 'Write the skill instructions here.',
  deleteSkillConfirm: 'Archive this skill?',
  mcpTitle: 'MCP Servers',
  mcpDescription: 'Manage the local and remote MCP servers available to Ekko at runtime.',
  enabledServers: 'Enabled',
  addServer: 'Add server',
  editServer: 'Edit server',
  managed: 'Studio managed',
  custom: 'Custom',
  managedHint: 'Studio-managed server definitions are injected automatically and can be edited, removed, enabled, or disabled per Profile.',
  noServers: 'No MCP servers configured',
  testServer: 'Test',
  testSuccess: 'Test completed; {count} tool(s) found',
  testFailed: 'Connection test failed',
  deleteServerConfirm: 'Delete this MCP server?',
  serverName: 'Server name',
  serverNamePlaceholder: 'for example: local-tools',
  serverConfig: 'Server config (JSON)',
  serverConfigHint: 'Use command/args/env for stdio, or type: streamable_http with url/headers for remote MCP.',
  missingCommand: 'Must include a non-empty command',
}

type EkkoConfigMessages = { [Key in keyof typeof ekkoConfigEn]: string }

export const ekkoConfigZh = {
  ...ekkoSettingsZh,
  ...ekkoSettingHintsZh,
  back: '返回', refresh: '刷新', loadFailed: '加载 Ekko 配置失败', deleted: '已删除',
  allStatuses: '全部状态', statusActive: '生效中', statusSuperseded: '已被替代', statusExpired: '已过期', statusDeleted: '已删除',
  memoryTitle: '记忆', memoryDescription: '查看和维护当前 Profile 的长期记忆。', searchMemory: '搜索记忆标题或内容…', noMemory: '没有匹配的记忆', graphView: '关联图', listView: '列表', memoryNodes: '个节点', memoryRelations: '条关系', relationRevision: '版本演进', relationSource: '同一来源', relationEntity: '共享实体', relatedMemories: '关联记忆', noRelations: '没有直接关联', memoryKey: '记忆键', memoryCategory: '分类', memoryEntities: '实体', memoryUpdatedAt: '更新时间', memoryScope: '作用域', memoryRevision: '版本', memoryConfidence: '置信度', memoryImportance: '重要度', memoryGraphHint: '选择节点可查看完整内容和关联关系。', editMemory: '编辑记忆', deleteMemoryConfirm: '软删除这条记忆？', titleLabel: '标题', contentLabel: '内容', tagsLabel: '标签', tagsPlaceholder: '使用逗号分隔标签',
  skillsTitle: 'Ekko Skills', skillsDescription: '创建和编辑 Ekko 可复用的工作指令。', newSkill: '新建 Skill', searchSkills: '搜索 Skills…', noSkills: '没有匹配的 Skills', selectSkill: '选择一个 Skill 或新建', skillName: 'Skill 名称', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md 必须包含 YAML frontmatter，且 name 与 Skill 名称一致，并包含 description 和精简的英文 metadata.keywords。', skillTemplateDescription: '说明 Ekko 应在什么情况下使用这个 Skill。', skillTemplateBody: '在这里编写 Skill 指令。', deleteSkillConfirm: '归档这个 Skill？',
  mcpTitle: 'MCP 服务器', mcpDescription: '管理 Ekko 运行时可用的本地及远程 MCP 服务。', enabledServers: '已启用', addServer: '添加服务', editServer: '编辑服务', managed: 'Studio 管理', custom: '自定义', managedHint: 'Studio 管理的服务由系统自动注入，也可以按 Profile 编辑、删除、启用或停用。', noServers: '尚未配置 MCP 服务', testServer: '测试', testSuccess: '测试完成，发现 {count} 个工具', testFailed: '连接测试失败', deleteServerConfirm: '删除这个 MCP 服务？', serverName: '服务名称', serverNamePlaceholder: '例如：local-tools', serverConfig: '服务配置（JSON）', serverConfigHint: '本地 MCP 使用 command/args/env；远程 MCP 使用 type: streamable_http、url 和可选 headers。', missingCommand: '必须包含非空的 command',
} satisfies EkkoConfigMessages

export const ekkoConfigZhTw = {
  ...ekkoConfigZh,
  ...ekkoSettingsZhTw,
  ...ekkoSettingHintsZhTw,
  back: '返回', refresh: '重新整理', loadFailed: '載入 Ekko 設定失敗', deleted: '已刪除',
  allStatuses: '全部狀態', statusActive: '生效中', statusSuperseded: '已被取代', statusExpired: '已過期', statusDeleted: '已刪除',
  memoryTitle: '記憶', memoryDescription: '檢視和維護目前 Profile 的長期記憶。', searchMemory: '搜尋記憶標題或內容…', noMemory: '沒有符合的記憶', graphView: '關聯圖', listView: '列表', memoryNodes: '個節點', memoryRelations: '條關係', relationRevision: '版本演進', relationSource: '同一來源', relationEntity: '共享實體', relatedMemories: '關聯記憶', noRelations: '沒有直接關聯', memoryKey: '記憶鍵', memoryCategory: '分類', memoryEntities: '實體', memoryUpdatedAt: '更新時間', memoryScope: '作用域', memoryRevision: '版本', memoryConfidence: '置信度', memoryImportance: '重要度', memoryGraphHint: '選擇節點可查看完整內容和關聯關係。', editMemory: '編輯記憶', deleteMemoryConfirm: '軟刪除這筆記憶？', titleLabel: '標題', contentLabel: '內容', tagsLabel: '標籤', tagsPlaceholder: '使用逗號分隔標籤',
  skillsDescription: '建立和編輯 Ekko 可重複使用的工作指令。', newSkill: '新增 Skill', searchSkills: '搜尋 Skills…', noSkills: '沒有符合的 Skills', selectSkill: '選擇一個 Skill 或新增', skillName: 'Skill 名稱', skillFormatHint: 'SKILL.md 必須包含 YAML frontmatter，且 name 與 Skill 名稱一致，並包含 description 和精簡的英文 metadata.keywords。', skillTemplateDescription: '說明 Ekko 應在什麼情況下使用這個 Skill。', skillTemplateBody: '在這裡編寫 Skill 指令。', deleteSkillConfirm: '封存這個 Skill？',
  mcpTitle: 'MCP 伺服器', mcpDescription: '管理 Ekko 執行時可用的本機及遠端 MCP 服務。', enabledServers: '已啟用', addServer: '新增服務', editServer: '編輯服務', managed: 'Studio 管理', custom: '自訂', managedHint: 'Studio 管理的服務由系統自動注入，也可以按 Profile 編輯、刪除、啟用或停用。', noServers: '尚未設定 MCP 服務', testServer: '測試', testSuccess: '測試完成，找到 {count} 個工具', testFailed: '連線測試失敗', deleteServerConfirm: '刪除這個 MCP 服務？', serverName: '服務名稱', serverNamePlaceholder: '例如：local-tools', serverConfig: '服務設定（JSON）', serverConfigHint: '本機 MCP 使用 command/args/env；遠端 MCP 使用 type: streamable_http、url 和可選 headers。', missingCommand: '必須包含非空的 command',
} satisfies EkkoConfigMessages

export const ekkoConfigDe = {
  ...ekkoSettingsDe,
  ...ekkoSettingHintsDe,
  back: 'Zurück', refresh: 'Aktualisieren', loadFailed: 'Ekko-Konfiguration konnte nicht geladen werden', deleted: 'Gelöscht',
  allStatuses: 'Alle Status', statusActive: 'Aktiv', statusSuperseded: 'Ersetzt', statusExpired: 'Abgelaufen', statusDeleted: 'Gelöscht',
  memoryTitle: 'Erinnerungen', memoryDescription: 'Dauerhafte Erinnerungen des aktiven Profils anzeigen und verwalten.', searchMemory: 'Titel oder Inhalt durchsuchen…', noMemory: 'Keine passenden Erinnerungen', graphView: 'Graph', listView: 'Liste', memoryNodes: 'Knoten', memoryRelations: 'Beziehungen', relationRevision: 'Versionsverlauf', relationSource: 'Gleiche Quelle', relationEntity: 'Gemeinsame Entität', relatedMemories: 'Verknüpfte Erinnerungen', noRelations: 'Keine direkten Beziehungen', memoryKey: 'Erinnerungsschlüssel', memoryCategory: 'Kategorie', memoryEntities: 'Entitäten', memoryUpdatedAt: 'Aktualisiert', memoryScope: 'Geltungsbereich', memoryRevision: 'Revision', memoryConfidence: 'Konfidenz', memoryImportance: 'Wichtigkeit', memoryGraphHint: 'Knoten auswählen, um Inhalt und Beziehungen anzuzeigen.', editMemory: 'Erinnerung bearbeiten', deleteMemoryConfirm: 'Diese Erinnerung als gelöscht markieren?', titleLabel: 'Titel', contentLabel: 'Inhalt', tagsLabel: 'Tags', tagsPlaceholder: 'Durch Kommas getrennte Tags',
  skillsTitle: 'Ekko-Skills', skillsDescription: 'Wiederverwendbare Anweisungen für Ekko erstellen und bearbeiten.', newSkill: 'Neuer Skill', searchSkills: 'Skills durchsuchen…', noSkills: 'Keine passenden Skills', selectSkill: 'Skill auswählen oder neu erstellen', skillName: 'Skill-Name', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md muss YAML-Frontmatter mit passenden Feldern für name, description und kompakten englischen metadata.keywords enthalten.', skillTemplateDescription: 'Beschreiben Sie, wann Ekko diesen Skill verwenden soll.', skillTemplateBody: 'Skill-Anweisungen hier eingeben.', deleteSkillConfirm: 'Diesen Skill archivieren?',
  mcpTitle: 'MCP-Server', mcpDescription: 'Lokale und entfernte MCP-Server verwalten, die Ekko zur Laufzeit verwenden kann.', enabledServers: 'Aktiviert', addServer: 'Server hinzufügen', editServer: 'Server bearbeiten', managed: 'Von Studio verwaltet', custom: 'Benutzerdefiniert', managedHint: 'Von Studio verwaltete Serverdefinitionen werden automatisch eingefügt und können pro Profil bearbeitet, entfernt, aktiviert oder deaktiviert werden.', noServers: 'Keine MCP-Server konfiguriert', testServer: 'Testen', testSuccess: 'Test abgeschlossen; {count} Tool(s) gefunden', testFailed: 'Verbindungstest fehlgeschlagen', deleteServerConfirm: 'Diesen MCP-Server löschen?', serverName: 'Servername', serverNamePlaceholder: 'zum Beispiel: local-tools', serverConfig: 'Serverkonfiguration (JSON)', serverConfigHint: 'Für stdio command/args/env verwenden; für Remote-MCP type: streamable_http mit url/headers.', missingCommand: 'Ein nicht leerer command ist erforderlich',
} satisfies EkkoConfigMessages

export const ekkoConfigEs = {
  ...ekkoSettingsEs,
  ...ekkoSettingHintsEs,
  back: 'Atrás', refresh: 'Actualizar', loadFailed: 'No se pudo cargar la configuración de Ekko', deleted: 'Eliminado',
  allStatuses: 'Todos los estados', statusActive: 'Activo', statusSuperseded: 'Reemplazado', statusExpired: 'Caducado', statusDeleted: 'Eliminado',
  memoryTitle: 'Memoria', memoryDescription: 'Consulta y administra los recuerdos permanentes del perfil activo.', searchMemory: 'Buscar por título o contenido…', noMemory: 'No hay recuerdos coincidentes', graphView: 'Grafo', listView: 'Lista', memoryNodes: 'nodos', memoryRelations: 'relaciones', relationRevision: 'Historial de versiones', relationSource: 'Mismo origen', relationEntity: 'Entidad compartida', relatedMemories: 'Recuerdos relacionados', noRelations: 'No hay relaciones directas', memoryKey: 'Clave de memoria', memoryCategory: 'Categoría', memoryEntities: 'Entidades', memoryUpdatedAt: 'Actualizado', memoryScope: 'Ámbito', memoryRevision: 'Revisión', memoryConfidence: 'Confianza', memoryImportance: 'Importancia', memoryGraphHint: 'Selecciona un nodo para ver su contenido y sus relaciones.', editMemory: 'Editar memoria', deleteMemoryConfirm: '¿Marcar esta memoria como eliminada?', titleLabel: 'Título', contentLabel: 'Contenido', tagsLabel: 'Etiquetas', tagsPlaceholder: 'Etiquetas separadas por comas',
  skillsTitle: 'Skills de Ekko', skillsDescription: 'Crea y edita las instrucciones reutilizables disponibles para Ekko.', newSkill: 'Nueva skill', searchSkills: 'Buscar skills…', noSkills: 'No hay skills coincidentes', selectSkill: 'Selecciona una skill o crea una nueva', skillName: 'Nombre de la skill', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md debe incluir encabezado YAML con name, description y metadata.keywords compactas en inglés.', skillTemplateDescription: 'Describe cuándo debe usar Ekko esta skill.', skillTemplateBody: 'Escribe aquí las instrucciones de la skill.', deleteSkillConfirm: '¿Archivar esta skill?',
  mcpTitle: 'Servidores MCP', mcpDescription: 'Administra los servidores MCP locales y remotos disponibles para Ekko durante la ejecución.', enabledServers: 'Activados', addServer: 'Añadir servidor', editServer: 'Editar servidor', managed: 'Administrado por Studio', custom: 'Personalizado', managedHint: 'Las definiciones administradas por Studio se inyectan automáticamente y se pueden editar, eliminar, activar o desactivar por perfil.', noServers: 'No hay servidores MCP configurados', testServer: 'Probar', testSuccess: 'Prueba completada; se encontraron {count} herramienta(s)', testFailed: 'Falló la prueba de conexión', deleteServerConfirm: '¿Eliminar este servidor MCP?', serverName: 'Nombre del servidor', serverNamePlaceholder: 'por ejemplo: local-tools', serverConfig: 'Configuración del servidor (JSON)', serverConfigHint: 'Usa command/args/env para stdio o type: streamable_http con url/headers para MCP remoto.', missingCommand: 'Debe incluir un command no vacío',
} satisfies EkkoConfigMessages

export const ekkoConfigFr = {
  ...ekkoSettingsFr,
  ...ekkoSettingHintsFr,
  back: 'Retour', refresh: 'Actualiser', loadFailed: 'Impossible de charger la configuration Ekko', deleted: 'Supprimé',
  allStatuses: 'Tous les états', statusActive: 'Actif', statusSuperseded: 'Remplacé', statusExpired: 'Expiré', statusDeleted: 'Supprimé',
  memoryTitle: 'Mémoire', memoryDescription: 'Consultez et gérez les souvenirs durables du profil actif.', searchMemory: 'Rechercher dans le titre ou le contenu…', noMemory: 'Aucun souvenir correspondant', graphView: 'Graphe', listView: 'Liste', memoryNodes: 'nœuds', memoryRelations: 'relations', relationRevision: 'Historique des versions', relationSource: 'Même source', relationEntity: 'Entité partagée', relatedMemories: 'Souvenirs associés', noRelations: 'Aucune relation directe', memoryKey: 'Clé de mémoire', memoryCategory: 'Catégorie', memoryEntities: 'Entités', memoryUpdatedAt: 'Mis à jour', memoryScope: 'Portée', memoryRevision: 'Révision', memoryConfidence: 'Confiance', memoryImportance: 'Importance', memoryGraphHint: 'Sélectionnez un nœud pour afficher son contenu et ses relations.', editMemory: 'Modifier le souvenir', deleteMemoryConfirm: 'Marquer ce souvenir comme supprimé ?', titleLabel: 'Titre', contentLabel: 'Contenu', tagsLabel: 'Tags', tagsPlaceholder: 'Tags séparés par des virgules',
  skillsTitle: 'Skills Ekko', skillsDescription: 'Créez et modifiez les instructions réutilisables disponibles pour Ekko.', newSkill: 'Nouveau skill', searchSkills: 'Rechercher des skills…', noSkills: 'Aucun skill correspondant', selectSkill: 'Sélectionnez un skill ou créez-en un', skillName: 'Nom du skill', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md doit contenir un en-tête YAML avec name, description et des metadata.keywords concises en anglais.', skillTemplateDescription: 'Décrivez quand Ekko doit utiliser ce skill.', skillTemplateBody: 'Rédigez ici les instructions du skill.', deleteSkillConfirm: 'Archiver ce skill ?',
  mcpTitle: 'Serveurs MCP', mcpDescription: 'Gérez les serveurs MCP locaux et distants disponibles pour Ekko à l’exécution.', enabledServers: 'Activés', addServer: 'Ajouter un serveur', editServer: 'Modifier le serveur', managed: 'Géré par Studio', custom: 'Personnalisé', managedHint: 'Les définitions gérées par Studio sont injectées automatiquement et peuvent être modifiées, supprimées, activées ou désactivées par profil.', noServers: 'Aucun serveur MCP configuré', testServer: 'Tester', testSuccess: 'Test terminé ; {count} outil(s) trouvé(s)', testFailed: 'Échec du test de connexion', deleteServerConfirm: 'Supprimer ce serveur MCP ?', serverName: 'Nom du serveur', serverNamePlaceholder: 'par exemple : local-tools', serverConfig: 'Configuration du serveur (JSON)', serverConfigHint: 'Utilisez command/args/env pour stdio, ou type: streamable_http avec url/headers pour un MCP distant.', missingCommand: 'Un command non vide est obligatoire',
} satisfies EkkoConfigMessages

export const ekkoConfigJa = {
  ...ekkoSettingsJa,
  ...ekkoSettingHintsJa,
  back: '戻る', refresh: '更新', loadFailed: 'Ekko 設定を読み込めませんでした', deleted: '削除済み',
  allStatuses: 'すべての状態', statusActive: '有効', statusSuperseded: '置換済み', statusExpired: '期限切れ', statusDeleted: '削除済み',
  memoryTitle: 'メモリ', memoryDescription: '現在のプロファイルの長期メモリを確認・管理します。', searchMemory: 'メモリのタイトルまたは内容を検索…', noMemory: '一致するメモリはありません', graphView: '関連グラフ', listView: 'リスト', memoryNodes: 'ノード', memoryRelations: '関係', relationRevision: 'バージョン履歴', relationSource: '同じソース', relationEntity: '共通エンティティ', relatedMemories: '関連メモリ', noRelations: '直接の関連はありません', memoryKey: 'メモリキー', memoryCategory: 'カテゴリ', memoryEntities: 'エンティティ', memoryUpdatedAt: '更新日時', memoryScope: 'スコープ', memoryRevision: 'リビジョン', memoryConfidence: '信頼度', memoryImportance: '重要度', memoryGraphHint: 'ノードを選択すると、内容と関連を確認できます。', editMemory: 'メモリを編集', deleteMemoryConfirm: 'このメモリを論理削除しますか？', titleLabel: 'タイトル', contentLabel: '内容', tagsLabel: 'タグ', tagsPlaceholder: 'タグをカンマ区切りで入力',
  skillsTitle: 'Ekko スキル', skillsDescription: 'Ekko が使用できる再利用可能な指示を作成・編集します。', newSkill: '新しいスキル', searchSkills: 'スキルを検索…', noSkills: '一致するスキルはありません', selectSkill: 'スキルを選択するか新規作成してください', skillName: 'スキル名', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md には、一致する name、description、簡潔な英語の metadata.keywords を含む YAML frontmatter が必要です。', skillTemplateDescription: 'Ekko がこのスキルを使用する条件を説明してください。', skillTemplateBody: 'ここにスキルの指示を記述します。', deleteSkillConfirm: 'このスキルをアーカイブしますか？',
  mcpTitle: 'MCP サーバー', mcpDescription: 'Ekko が実行時に使用できるローカルおよびリモート MCP サーバーを管理します。', enabledServers: '有効', addServer: 'サーバーを追加', editServer: 'サーバーを編集', managed: 'Studio 管理', custom: 'カスタム', managedHint: 'Studio 管理のサーバー定義は自動的に注入され、プロファイルごとに編集、削除、有効化、無効化できます。', noServers: 'MCP サーバーが設定されていません', testServer: 'テスト', testSuccess: 'テスト完了：{count} 個のツールを検出', testFailed: '接続テストに失敗しました', deleteServerConfirm: 'この MCP サーバーを削除しますか？', serverName: 'サーバー名', serverNamePlaceholder: '例：local-tools', serverConfig: 'サーバー設定（JSON）', serverConfigHint: 'stdio には command/args/env、リモート MCP には type: streamable_http と url/headers を使用します。', missingCommand: '空でない command が必要です',
} satisfies EkkoConfigMessages

export const ekkoConfigKo = {
  ...ekkoSettingsKo,
  ...ekkoSettingHintsKo,
  back: '뒤로', refresh: '새로고침', loadFailed: 'Ekko 설정을 불러오지 못했습니다', deleted: '삭제됨',
  allStatuses: '모든 상태', statusActive: '활성', statusSuperseded: '대체됨', statusExpired: '만료됨', statusDeleted: '삭제됨',
  memoryTitle: '메모리', memoryDescription: '현재 프로필의 장기 메모리를 확인하고 관리합니다.', searchMemory: '메모리 제목 또는 내용 검색…', noMemory: '일치하는 메모리가 없습니다', graphView: '관계 그래프', listView: '목록', memoryNodes: '노드', memoryRelations: '관계', relationRevision: '버전 기록', relationSource: '동일한 출처', relationEntity: '공유 엔터티', relatedMemories: '관련 메모리', noRelations: '직접 연결된 관계가 없습니다', memoryKey: '메모리 키', memoryCategory: '카테고리', memoryEntities: '엔터티', memoryUpdatedAt: '업데이트', memoryScope: '범위', memoryRevision: '리비전', memoryConfidence: '신뢰도', memoryImportance: '중요도', memoryGraphHint: '노드를 선택하면 내용과 관계를 확인할 수 있습니다.', editMemory: '메모리 편집', deleteMemoryConfirm: '이 메모리를 소프트 삭제할까요?', titleLabel: '제목', contentLabel: '내용', tagsLabel: '태그', tagsPlaceholder: '쉼표로 태그 구분',
  skillsTitle: 'Ekko 스킬', skillsDescription: 'Ekko에서 사용할 재사용 가능한 지침을 만들고 편집합니다.', newSkill: '새 스킬', searchSkills: '스킬 검색…', noSkills: '일치하는 스킬이 없습니다', selectSkill: '스킬을 선택하거나 새로 만드세요', skillName: '스킬 이름', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md에는 일치하는 name, description 및 간결한 영어 metadata.keywords가 있는 YAML frontmatter가 필요합니다.', skillTemplateDescription: 'Ekko가 이 스킬을 사용해야 하는 상황을 설명하세요.', skillTemplateBody: '여기에 스킬 지침을 작성하세요.', deleteSkillConfirm: '이 스킬을 보관할까요?',
  mcpTitle: 'MCP 서버', mcpDescription: 'Ekko가 런타임에 사용할 수 있는 로컬 및 원격 MCP 서버를 관리합니다.', enabledServers: '활성화됨', addServer: '서버 추가', editServer: '서버 편집', managed: 'Studio 관리', custom: '사용자 지정', managedHint: 'Studio 관리 서버 정의는 자동으로 주입되며 프로필별로 편집, 삭제, 활성화 또는 비활성화할 수 있습니다.', noServers: '설정된 MCP 서버가 없습니다', testServer: '테스트', testSuccess: '테스트 완료: 도구 {count}개 발견', testFailed: '연결 테스트 실패', deleteServerConfirm: '이 MCP 서버를 삭제할까요?', serverName: '서버 이름', serverNamePlaceholder: '예: local-tools', serverConfig: '서버 설정(JSON)', serverConfigHint: 'stdio에는 command/args/env를, 원격 MCP에는 type: streamable_http와 url/headers를 사용하세요.', missingCommand: '비어 있지 않은 command가 필요합니다',
} satisfies EkkoConfigMessages

export const ekkoConfigPt = {
  ...ekkoSettingsPt,
  ...ekkoSettingHintsPt,
  back: 'Voltar', refresh: 'Atualizar', loadFailed: 'Falha ao carregar a configuração do Ekko', deleted: 'Excluído',
  allStatuses: 'Todos os status', statusActive: 'Ativo', statusSuperseded: 'Substituído', statusExpired: 'Expirado', statusDeleted: 'Excluído',
  memoryTitle: 'Memória', memoryDescription: 'Visualize e gerencie as memórias duradouras do perfil ativo.', searchMemory: 'Buscar no título ou conteúdo…', noMemory: 'Nenhuma memória correspondente', graphView: 'Grafo', listView: 'Lista', memoryNodes: 'nós', memoryRelations: 'relações', relationRevision: 'Histórico de versões', relationSource: 'Mesma origem', relationEntity: 'Entidade compartilhada', relatedMemories: 'Memórias relacionadas', noRelations: 'Nenhuma relação direta', memoryKey: 'Chave da memória', memoryCategory: 'Categoria', memoryEntities: 'Entidades', memoryUpdatedAt: 'Atualizado', memoryScope: 'Escopo', memoryRevision: 'Revisão', memoryConfidence: 'Confiança', memoryImportance: 'Importância', memoryGraphHint: 'Selecione um nó para ver seu conteúdo e suas relações.', editMemory: 'Editar memória', deleteMemoryConfirm: 'Marcar esta memória como excluída?', titleLabel: 'Título', contentLabel: 'Conteúdo', tagsLabel: 'Tags', tagsPlaceholder: 'Tags separadas por vírgulas',
  skillsTitle: 'Skills do Ekko', skillsDescription: 'Crie e edite as instruções reutilizáveis disponíveis para o Ekko.', newSkill: 'Nova skill', searchSkills: 'Buscar skills…', noSkills: 'Nenhuma skill correspondente', selectSkill: 'Selecione uma skill ou crie uma nova', skillName: 'Nome da skill', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md deve incluir frontmatter YAML com name, description e metadata.keywords compactas em inglês.', skillTemplateDescription: 'Descreva quando o Ekko deve usar esta skill.', skillTemplateBody: 'Escreva aqui as instruções da skill.', deleteSkillConfirm: 'Arquivar esta skill?',
  mcpTitle: 'Servidores MCP', mcpDescription: 'Gerencie os servidores MCP locais e remotos disponíveis para o Ekko em tempo de execução.', enabledServers: 'Ativados', addServer: 'Adicionar servidor', editServer: 'Editar servidor', managed: 'Gerenciado pelo Studio', custom: 'Personalizado', managedHint: 'As definições gerenciadas pelo Studio são injetadas automaticamente e podem ser editadas, removidas, ativadas ou desativadas por perfil.', noServers: 'Nenhum servidor MCP configurado', testServer: 'Testar', testSuccess: 'Teste concluído; {count} ferramenta(s) encontrada(s)', testFailed: 'Falha no teste de conexão', deleteServerConfirm: 'Excluir este servidor MCP?', serverName: 'Nome do servidor', serverNamePlaceholder: 'por exemplo: local-tools', serverConfig: 'Configuração do servidor (JSON)', serverConfigHint: 'Use command/args/env para stdio ou type: streamable_http com url/headers para MCP remoto.', missingCommand: 'É necessário incluir um command não vazio',
} satisfies EkkoConfigMessages

export const ekkoConfigRu = {
  ...ekkoSettingsRu,
  ...ekkoSettingHintsRu,
  back: 'Назад', refresh: 'Обновить', loadFailed: 'Не удалось загрузить конфигурацию Ekko', deleted: 'Удалено',
  allStatuses: 'Все статусы', statusActive: 'Активно', statusSuperseded: 'Заменено', statusExpired: 'Истекло', statusDeleted: 'Удалено',
  memoryTitle: 'Память', memoryDescription: 'Просмотр и управление долговременной памятью активного профиля.', searchMemory: 'Поиск по заголовку или содержимому…', noMemory: 'Подходящих воспоминаний нет', graphView: 'Граф', listView: 'Список', memoryNodes: 'узлов', memoryRelations: 'связей', relationRevision: 'История версий', relationSource: 'Общий источник', relationEntity: 'Общая сущность', relatedMemories: 'Связанные воспоминания', noRelations: 'Прямых связей нет', memoryKey: 'Ключ памяти', memoryCategory: 'Категория', memoryEntities: 'Сущности', memoryUpdatedAt: 'Обновлено', memoryScope: 'Область', memoryRevision: 'Ревизия', memoryConfidence: 'Уверенность', memoryImportance: 'Важность', memoryGraphHint: 'Выберите узел, чтобы просмотреть его содержимое и связи.', editMemory: 'Изменить воспоминание', deleteMemoryConfirm: 'Пометить это воспоминание как удалённое?', titleLabel: 'Заголовок', contentLabel: 'Содержимое', tagsLabel: 'Теги', tagsPlaceholder: 'Теги через запятую',
  skillsTitle: 'Навыки Ekko', skillsDescription: 'Создание и редактирование повторно используемых инструкций для Ekko.', newSkill: 'Новый навык', searchSkills: 'Поиск навыков…', noSkills: 'Подходящих навыков нет', selectSkill: 'Выберите навык или создайте новый', skillName: 'Название навыка', skillContent: 'SKILL.md', skillFormatHint: 'SKILL.md должен содержать YAML frontmatter с полями name, description и краткими английскими metadata.keywords.', skillTemplateDescription: 'Опишите, когда Ekko должен использовать этот навык.', skillTemplateBody: 'Введите здесь инструкции навыка.', deleteSkillConfirm: 'Архивировать этот навык?',
  mcpTitle: 'Серверы MCP', mcpDescription: 'Управление локальными и удалёнными MCP-серверами, доступными Ekko во время работы.', enabledServers: 'Включены', addServer: 'Добавить сервер', editServer: 'Изменить сервер', managed: 'Управляется Studio', custom: 'Пользовательский', managedHint: 'Определения серверов Studio добавляются автоматически; их можно изменять, удалять, включать и отключать для каждого профиля.', noServers: 'MCP-серверы не настроены', testServer: 'Проверить', testSuccess: 'Проверка завершена; найдено инструментов: {count}', testFailed: 'Проверка подключения не удалась', deleteServerConfirm: 'Удалить этот MCP-сервер?', serverName: 'Имя сервера', serverNamePlaceholder: 'например: local-tools', serverConfig: 'Конфигурация сервера (JSON)', serverConfigHint: 'Для stdio используйте command/args/env, для удалённого MCP — type: streamable_http с url/headers.', missingCommand: 'Требуется непустой command',
} satisfies EkkoConfigMessages

export const ekkoConfigAr = {
  ...ekkoSettingsAr,
  ...ekkoSettingHintsAr,
  back: 'رجوع', refresh: 'تحديث', loadFailed: 'تعذر تحميل إعدادات Ekko', deleted: 'تم الحذف',
  allStatuses: 'كل الحالات', statusActive: 'نشط', statusSuperseded: 'مستبدل', statusExpired: 'منتهي الصلاحية', statusDeleted: 'محذوف',
  memoryTitle: 'الذاكرة', memoryDescription: 'عرض الذكريات طويلة الأمد للملف النشط وإدارتها.', searchMemory: 'البحث في عنوان الذاكرة أو محتواها…', noMemory: 'لا توجد ذكريات مطابقة', graphView: 'مخطط العلاقات', listView: 'قائمة', memoryNodes: 'عقد', memoryRelations: 'علاقات', relationRevision: 'سجل الإصدارات', relationSource: 'المصدر نفسه', relationEntity: 'كيان مشترك', relatedMemories: 'ذكريات مرتبطة', noRelations: 'لا توجد علاقات مباشرة', memoryKey: 'مفتاح الذاكرة', memoryCategory: 'الفئة', memoryEntities: 'الكيانات', memoryUpdatedAt: 'آخر تحديث', memoryScope: 'النطاق', memoryRevision: 'الإصدار', memoryConfidence: 'مستوى الثقة', memoryImportance: 'الأهمية', memoryGraphHint: 'حدد عقدة لعرض محتواها وعلاقاتها.', editMemory: 'تعديل الذاكرة', deleteMemoryConfirm: 'هل تريد حذف هذه الذاكرة حذفًا منطقيًا؟', titleLabel: 'العنوان', contentLabel: 'المحتوى', tagsLabel: 'الوسوم', tagsPlaceholder: 'وسوم مفصولة بفواصل',
  skillsTitle: 'مهارات Ekko', skillsDescription: 'إنشاء التعليمات القابلة لإعادة الاستخدام والمتاحة لـ Ekko وتعديلها.', newSkill: 'مهارة جديدة', searchSkills: 'البحث في المهارات…', noSkills: 'لا توجد مهارات مطابقة', selectSkill: 'حدد مهارة أو أنشئ واحدة جديدة', skillName: 'اسم المهارة', skillContent: 'SKILL.md', skillFormatHint: 'يجب أن يتضمن SKILL.md ترويسة YAML تحتوي name وdescription وmetadata.keywords إنجليزية موجزة.', skillTemplateDescription: 'صف متى يجب على Ekko استخدام هذه المهارة.', skillTemplateBody: 'اكتب تعليمات المهارة هنا.', deleteSkillConfirm: 'هل تريد أرشفة هذه المهارة؟',
  mcpTitle: 'خوادم MCP', mcpDescription: 'إدارة خوادم MCP المحلية والبعيدة المتاحة لـ Ekko أثناء التشغيل.', enabledServers: 'مفعّلة', addServer: 'إضافة خادم', editServer: 'تعديل الخادم', managed: 'تحت إدارة Studio', custom: 'مخصص', managedHint: 'تُضاف تعريفات الخوادم التي يديرها Studio تلقائيًا، ويمكن تعديلها أو حذفها أو تفعيلها أو تعطيلها لكل ملف.', noServers: 'لم يتم إعداد خوادم MCP', testServer: 'اختبار', testSuccess: 'اكتمل الاختبار؛ تم العثور على {count} أداة', testFailed: 'فشل اختبار الاتصال', deleteServerConfirm: 'هل تريد حذف خادم MCP هذا؟', serverName: 'اسم الخادم', serverNamePlaceholder: 'مثال: local-tools', serverConfig: 'إعدادات الخادم (JSON)', serverConfigHint: 'استخدم command/args/env مع stdio، أو type: streamable_http مع url/headers لخادم MCP البعيد.', missingCommand: 'يجب تضمين command غير فارغ',
} satisfies EkkoConfigMessages
