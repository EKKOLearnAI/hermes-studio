export default {
  nav: {
    home: '首页',
    docs: '文档',
    github: 'GitHub',
  },
  hero: {
    title: '自托管 AI 聊天仪表板',
    subtitle: '开源 AI Agent 仪表板 — 流式对话、多模型调度、看板管理、用量分析、Web 终端，一个界面掌控一切。',
    cta: '快速开始',
    viewGithub: '查看 GitHub',
    install: 'npm install -g hermes-web-ui',
  },
  features: {
    title: '功能齐全',
    desc: '开箱即用的完整 AI Agent 管理仪表板。',
    streaming: {
      title: '流式聊天',
      desc: '基于 Socket.IO 的实时 AI 对话，支持多会话管理、Markdown 渲染和代码语法高亮。',
    },
    platforms: {
      title: '8 大平台',
      desc: '统一管理 Telegram、Discord、Slack、WhatsApp、Matrix、飞书、微信、企业微信。',
    },
    multiModel: {
      title: '多模型支持',
      desc: '支持 Claude、GPT、Gemini、DeepSeek 及任何 OpenAI 兼容模型，自动发现。',
    },
    groupChat: {
      title: '群聊协作',
      desc: '多 Agent 聊天室，支持提及路由、上下文压缩和实时协作。',
    },
    kanban: {
      title: '看板管理',
      desc: '可视化任务看板，7 个状态列，支持任务分配和筛选。',
    },
    analytics: {
      title: '用量分析',
      desc: 'Token 用量、费用追踪、缓存命中率、模型分布和 30 天趋势。',
    },
    profiles: {
      title: '多配置',
      desc: '按账号授权的 Hermes Profile，隔离配置、模型、上传、任务、用量、记忆、技能、插件和 Provider。',
    },
    files: {
      title: '文件管理',
      desc: '跨本地、Docker、SSH 和 Singularity 管理文件，支持按 Profile 上传、按路径下载、预览和编辑。',
    },
    terminal: {
      title: 'Web 终端',
      desc: '浏览器内完整 PTY 终端，基于 WebSocket 和 xterm.js 的多会话支持。',
    },
    quickInstall: {
      title: '一键安装',
      desc: '一条命令安装启动。初始化 Web UI 数据、启动 bridge 并打开浏览器。',
    },
    i18n: {
      title: '8 种语言',
      desc: '内置英语、中文、德语、西班牙语、法语、日语、韩语和葡萄牙语。',
    },
    theme: {
      title: '暗色 / 亮色',
      desc: '水墨单色设计，平滑主题切换，响应式布局适配移动端和桌面端。',
    },
  },
  platforms: {
    title: '统一平台管理',
    desc: '在一个页面配置 8 大消息平台的凭证和行为。',
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    whatsapp: 'WhatsApp',
    matrix: 'Matrix',
    feishu: '飞书',
    wechat: '微信',
    wecom: '企业微信',
  },
  install: {
    title: '快速开始',
    desc: '一分钟内启动 Hermes Web UI。',
    npm: {
      title: 'npm',
      cmd1: 'npm install -g hermes-web-ui',
      cmd2: 'hermes-web-ui start',
    },
    docker: {
      title: 'Docker',
      cmd: 'docker compose up -d',
    },
    source: {
      title: '源码安装',
      cmd1: 'git clone https://github.com/EKKOLearnAI/hermes-web-ui.git',
      cmd2: 'cd hermes-web-ui && npm install && npm run dev',
    },
    prereq: '需要 Node.js >= 23',
  },
  starHistory: {
    title: '社区成长',
    desc: '在 GitHub 上给我们加星，加入社区。',
  },
  footer: {
    description: 'Hermes Agent 的自托管 AI 聊天仪表板。',
    license: 'BSL-1.1 开源协议',
    madeWith: '使用 Vue 3、Naive UI 和 TypeScript 构建。',
  },
  docs: {
    sidebar: {
      gettingStarted: '快速开始',
      configuration: '配置说明',
      features: '功能详解',
      platforms: '平台接入',
      api: 'API 参考',
    },
    gettingStarted: {
      title: '快速开始',
      intro: 'Hermes Web UI 是一个自托管的 Web 仪表板，用于管理 AI 对话、平台通道、定时任务等。它封装了 Hermes Agent CLI 并提供美观的 Web 界面。',
      install: {
        title: '安装',
        content: '通过 npm 全局安装。需要 Node.js 23 或更高版本。',
      },
      firstRun: {
        title: '首次运行',
        content: '首次启动时，Hermes Web UI 会自动生成认证令牌、初始化本地数据、启动 Hermes agent bridge 并在浏览器中打开仪表板。',
      },
      login: {
        title: '登录',
        content: '自动生成的令牌存储在 ~/.hermes-web-ui/.token。首次使用可通过默认登录名 admin / 默认密码 123456 登录；登录后系统会提示尽快修改默认账户和密码。',
      },
    },
    configuration: {
      title: '配置说明',
      intro: 'Hermes Web UI 可通过环境变量进行配置。',
      envVars: {
        title: '环境变量',
        rows: [
          ['AUTH_DISABLED', '设为 "1" 禁用认证'],
          ['AUTH_TOKEN', '自定义认证令牌（覆盖自动生成的令牌）'],
          ['PORT', '服务器监听端口（默认：8648）'],
          ['BIND_HOST', '服务器绑定地址（默认：0.0.0.0）。如需 IPv6，请显式设置为 ::。'],
          ['UPLOAD_DIR', '自定义上传根目录。文件会保存在按 Profile 隔离的子目录下'],
          ['CORS_ORIGINS', 'CORS 来源配置（默认：*）'],
          ['HERMES_BIN', '自定义 hermes CLI 二进制路径'],
        ],
      },
      gateway: {
        title: 'Agent Bridge 运行时',
        content: '聊天运行通过 Hermes agent bridge 处理。它随 Web UI 服务一起运行，并直接连接 Hermes Agent runtime。前端切换 Hermes Profile 只影响后续请求上下文，不会重启 bridge 或清理其他正在运行的任务。',
      },
      profiles: {
        title: '配置文件',
        content: 'Profile 为不同场景提供隔离配置。超级管理员可以管理全部 Profile；普通管理员只能查看和使用分配给自己的 Profile。可在 Profile 页面创建、克隆、导入、导出或切换 Hermes Profile。',
      },
    },
    features: {
      title: '功能详解',
      intro: '探索 Hermes Web UI 的核心功能。',
      chat: {
        title: 'AI 聊天',
        content: '通过 Socket.IO /chat-run 实时流式聊天。支持多会话管理、Markdown 渲染与语法高亮、工具调用检查、按 Profile 上传、按路径下载，以及 Ctrl+K 搜索 Web UI 本地会话库。',
      },
      kanban: {
        title: '看板管理',
        content: '可视化任务看板，包含 7 个状态列：分流、待办、就绪、运行中、阻塞、完成和已归档。支持任务分配、筛选和通过侧边抽屉进行详细编辑。',
      },
      groupChat: {
        title: '群聊协作',
        content: '多 Agent 聊天室，多个 AI Agent 协同工作。支持提及路由触发特定 Agent、历史记录超限时自动压缩上下文、输入状态指示和基于 SQLite 的消息持久化。',
      },
      jobs: {
        title: '定时任务',
        content: '创建和管理基于 cron 的定时任务，自动运行 AI 任务。可配置计划、提示词和模型。',
      },
      skills: {
        title: '技能',
        content: '浏览和管理已安装的 AI 技能。技能通过专业知识和工具集成扩展 Agent 能力。',
      },
      memory: {
        title: '记忆',
        content: '管理 Agent 记忆和用户笔记。Agent 使用记忆在对话间保持上下文并提供个性化回复。',
      },
      terminal: {
        title: '终端',
        content: '基于 node-pty 和 xterm.js 的浏览器内完整伪终端。支持多个终端会话、实时键盘输入和通过 WebSocket 的窗口大小调整。',
      },
      files: {
        title: '文件管理',
        content: '浏览和管理本地、Docker、SSH 和 Singularity 等远程后端上的文件。上传保存到当前选择/请求的 Profile；下载按真实路径解析，因此上传目录外的 Agent 产物也可以下载。',
      },
      analytics: {
        title: '用量分析',
        content: '追踪 Token 用量（输入/输出）、预估费用、缓存命中率、会话数和模型分布。查看 30 天日趋势交互图表。',
      },
    },
    platforms: {
      title: '平台接入',
      intro: '从通道设置页面配置消息平台集成。',
      telegram: {
        title: 'Telegram',
        content: '通过 BotFather 创建 Telegram Bot，输入 Bot Token。可配置提及要求、自由回复聊天和反应处理。',
      },
      discord: {
        title: 'Discord',
        content: '在开发者门户创建 Discord Bot。支持自动创建线程、允许/忽略频道、反应处理和自由回复频道。',
      },
      slack: {
        title: 'Slack',
        content: '创建带有 bot token 权限的 Slack App。配置提及要求、Bot 白名单和自由回复频道。',
      },
      whatsapp: {
        title: 'WhatsApp',
        content: '启用 WhatsApp 集成，配置提及模式和自由回复聊天。',
      },
      matrix: {
        title: 'Matrix',
        content: '提供访问令牌和服务器 URL。支持自动线程、私聊提及线程和自由回复房间。',
      },
      feishu: {
        title: '飞书',
        content: '注册飞书应用并配置 App ID 和 Secret。',
      },
      wechat: {
        title: '微信',
        content: '从设置页面扫描二维码登录。凭据会自动保存供后续使用。',
      },
      wecom: {
        title: '企业微信',
        content: '从企业微信管理后台配置 Bot ID 和 Secret。',
      },
    },
    api: {
      title: 'API 参考',
      intro: 'Hermes Web UI 提供本地 BFF API，并通过 Socket.IO 端点进行聊天流式通信。',
      local: {
        title: '本地 BFF 端点',
        content: 'Koa 服务器处理会话管理、Profile CRUD、分账户分 Profile 管理、配置读写、日志访问、技能列表、记忆操作和静态资源。',
      },
      proxy: {
        title: '聊天流式通信',
        content: '聊天运行使用 /chat-run Socket.IO 命名空间和 Hermes agent bridge。旧 gateway proxy 路由仅在兼容场景下保留。',
      },
      auth: {
        title: '认证',
        content: 'API 端点需要经过认证访问。令牌在首次运行时自动生成并存储在 ~/.hermes-web-ui/.token。用户名/密码登录使用账户记录；超级管理员管理用户和 Profile 绑定，普通管理员管理自己的账户信息。',
      },
    },
  },
}
