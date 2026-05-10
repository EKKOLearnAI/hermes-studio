export default {
  nav: {
    home: 'Home',
    docs: 'Documentation',
    github: 'GitHub',
    qqGroup: 'QQ Group',
  },
  hero: {
    title: 'Self-Hosted AI Chat Dashboard',
    subtitle: 'Open-source AI agent dashboard — streaming chat, multi-model routing, Kanban boards, usage analytics, web terminal, all in one self-hosted interface.',
    cta: 'Get Started',
    viewGithub: 'View on GitHub',
    install: 'npm install -g hermes-web-ui',
  },
  features: {
    title: 'Everything You Need',
    desc: 'A complete AI agent management dashboard with rich features out of the box.',
    streaming: {
      title: 'Streaming Chat',
      desc: 'Real-time SSE-powered AI conversations with multi-session management, Markdown rendering, and code syntax highlighting.',
    },
    platforms: {
      title: '8 Platforms',
      desc: 'Unified management for Telegram, Discord, Slack, WhatsApp, Matrix, Feishu, WeChat, and WeCom channels.',
    },
    multiModel: {
      title: 'Multi-Model',
      desc: 'Support for Claude, GPT, Gemini, DeepSeek, and any OpenAI-compatible provider with auto-discovery.',
    },
    groupChat: {
      title: 'Group Chat',
      desc: 'Multi-agent chat rooms with mention routing, context compression, and real-time collaboration.',
    },
    kanban: {
      title: 'Kanban Board',
      desc: 'Visual task management with 7 status columns, assignee tracking, and filtering for AI-driven workflows.',
    },
    analytics: {
      title: 'Usage Analytics',
      desc: 'Token usage breakdown, cost tracking, cache hit rates, model distribution, and 30-day trends.',
    },
    profiles: {
      title: 'Multi-Profile',
      desc: 'Isolated profiles with independent configs. Clone, import/export profiles, run multiple gateways.',
    },
    files: {
      title: 'File Browser',
      desc: 'Manage files across local, Docker, SSH, and Singularity backends with upload, preview, and edit.',
    },
    terminal: {
      title: 'Web Terminal',
      desc: 'Full PTY terminal in the browser with multi-session support via WebSocket and xterm.js.',
    },
    quickInstall: {
      title: 'One Command',
      desc: 'Install and start with a single command. Auto-detects config, resolves ports, opens the browser.',
    },
    i18n: {
      title: '8 Languages',
      desc: 'Built-in support for English, Chinese, German, Spanish, French, Japanese, Korean, and Portuguese.',
    },
    theme: {
      title: 'Dark / Light',
      desc: 'Pure Ink monochrome design with smooth theme switching. Responsive layout for mobile and desktop.',
    },
  },
  platforms: {
    title: 'Unified Platform Management',
    desc: 'Configure credentials and behavior for 8 messaging platforms from a single settings page.',
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    whatsapp: 'WhatsApp',
    matrix: 'Matrix',
    feishu: 'Feishu',
    wechat: 'WeChat',
    wecom: 'WeCom',
  },
  install: {
    title: 'Quick Start',
    desc: 'Get Hermes Web UI running in under a minute.',
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
      title: 'From Source',
      cmd1: 'git clone https://github.com/EKKOLearnAI/hermes-web-ui.git',
      cmd2: 'cd hermes-web-ui && npm install && npm run dev',
    },
    prereq: 'Requires Node.js >= 23',
  },
  starHistory: {
    title: 'Growing Community',
    desc: 'Star us on GitHub and join the community.',
  },
  footer: {
    description: 'Self-hosted AI chat dashboard for Hermes Agent.',
    license: 'MIT License',
    madeWith: 'Built with Vue 3, Naive UI, and TypeScript.',
  },
  docs: {
    sidebar: {
      gettingStarted: 'Getting Started',
      configuration: 'Configuration',
      features: 'Features',
      platforms: 'Platform Guides',
      api: 'API Reference',
    },
    gettingStarted: {
      title: 'Getting Started',
      intro: 'Hermes Web UI is a self-hosted web dashboard for managing AI conversations, platform channels, scheduled jobs, and more. It wraps the Hermes Agent CLI and provides a beautiful web interface.',
      install: {
        title: 'Installation',
        content: 'Install globally via npm. Node.js 23 or higher is required.',
      },
      firstRun: {
        title: 'First Run',
        content: 'On first start, Hermes Web UI will automatically generate an auth token, validate configuration files, start the Hermes gateway, and open the dashboard in your browser.',
      },
      login: {
        title: 'Login',
        content: 'The auto-generated token is stored in ~/.hermes-web-ui/.token. You can also set up username/password login from the Settings page after your first login.',
      },
    },
    configuration: {
      title: 'Configuration',
      intro: 'Hermes Web UI can be configured via environment variables.',
      envVars: {
        title: 'Environment Variables',
        rows: [
          ['AUTH_DISABLED', 'Set to "1" to disable authentication'],
          ['AUTH_TOKEN', 'Custom auth token (overrides auto-generated)'],
          ['PORT', 'Server listen port (default: 8648)'],
          ['BIND_HOST', 'Server bind host (default: 0.0.0.0). Set :: explicitly to enable IPv6 listening.'],
          ['UPLOAD_DIR', 'Custom upload directory path'],
          ['CORS_ORIGINS', 'CORS origin config (default: *)'],
          ['HERMES_BIN', 'Custom path to hermes CLI binary'],
        ],
      },
      gateway: {
        title: 'Gateway Management',
        content: 'The gateway is the Hermes Agent process that handles AI conversations. Hermes Web UI manages the gateway lifecycle — start, stop, and monitor from the Gateways page. Multiple gateways can run with different profiles, and each profile resolves its own gateway host/port from its Hermes config.',
      },
      profiles: {
        title: 'Profiles',
        content: 'Profiles provide isolated configurations for different use cases. Each profile has its own Hermes config, cache, and gateway. Create, clone, import, or export profiles from the Profiles page.',
      },
    },
    features: {
      title: 'Features',
      intro: 'Explore the core features of Hermes Web UI.',
      chat: {
        title: 'AI Chat',
        content: 'Real-time streaming chat powered by Server-Sent Events. Supports multi-session management, Markdown rendering with syntax highlighting, tool call inspection, file upload/download, and global search across all conversations (Ctrl+K).',
      },
      kanban: {
        title: 'Kanban Board',
        content: 'A visual task management board with 7 status columns: triage, todo, ready, running, blocked, done, and archived. Supports assignee management, filtering, and detailed task editing via a side drawer.',
      },
      groupChat: {
        title: 'Group Chat',
        content: 'Multi-agent chat rooms where multiple AI agents collaborate. Features mention routing to trigger specific agents, automatic context compression when history exceeds limits, typing indicators, and SQLite-based message persistence.',
      },
      jobs: {
        title: 'Scheduled Jobs',
        content: 'Create and manage cron-based scheduled jobs that run AI tasks automatically. Configure schedule, prompt, and model for each job.',
      },
      skills: {
        title: 'Skills',
        content: 'Browse and manage installed AI skills. Skills extend the agent\'s capabilities with specialized knowledge and tool integrations.',
      },
      memory: {
        title: 'Memory',
        content: 'Manage agent memory and user notes. The agent uses memory to maintain context across conversations and personalize responses.',
      },
      terminal: {
        title: 'Terminal',
        content: 'Full pseudo-terminal in the browser powered by node-pty and xterm.js. Supports multiple terminal sessions, real-time keyboard input, and window resizing via WebSocket.',
      },
      files: {
        title: 'File Browser',
        content: 'Browse and manage files on remote backends including local, Docker, SSH, and Singularity. Upload, download, rename, move, delete files, and preview content with syntax highlighting.',
      },
      analytics: {
        title: 'Usage Analytics',
        content: 'Track token usage (input/output), estimated costs, cache hit rates, session counts, and model distribution. View 30-day daily trends with interactive charts.',
      },
    },
    platforms: {
      title: 'Platform Guides',
      intro: 'Configure messaging platform integrations from the Channels settings page.',
      telegram: {
        title: 'Telegram',
        content: 'Create a Telegram Bot via BotFather, then enter the bot token. Configure mention requirements, free-response chats, and reaction handling.',
      },
      discord: {
        title: 'Discord',
        content: 'Create a Discord Bot in the Developer Portal. Supports auto-thread creation, allowed/ignored channels, reaction handling, and free-response channels.',
      },
      slack: {
        title: 'Slack',
        content: 'Create a Slack App with bot token scope. Configure mention requirements, bot allowlisting, and free-response channels.',
      },
      whatsapp: {
        title: 'WhatsApp',
        content: 'Enable WhatsApp integration and configure mention patterns and free-response chats.',
      },
      matrix: {
        title: 'Matrix',
        content: 'Provide access token and homeserver URL. Supports auto-thread, DM mention threads, and free-response rooms.',
      },
      feishu: {
        title: 'Feishu (Lark)',
        content: 'Register a Feishu app and configure App ID and Secret.',
      },
      wechat: {
        title: 'WeChat',
        content: 'Scan the QR code from the settings page to log in. Credentials are auto-saved for subsequent sessions.',
      },
      wecom: {
        title: 'WeCom',
        content: 'Configure Bot ID and Secret from the WeCom admin console.',
      },
    },
    api: {
      title: 'API Reference',
      intro: 'Hermes Web UI provides both a local BFF API and proxies requests to the upstream Hermes gateway.',
      local: {
        title: 'Local BFF Endpoints',
        content: 'The Koa server handles session management, profile CRUD, config read/write, log access, skill listing, and memory operations. These endpoints call the Hermes CLI directly.',
      },
      proxy: {
        title: 'Gateway Proxy',
        content: 'Requests to /api/hermes/v1/* are forwarded to the Hermes gateway. This includes AI model interactions, run management, and streaming events.',
      },
      auth: {
        title: 'Authentication',
        content: 'All API endpoints require a Bearer token via the Authorization header. The token is auto-generated on first run and stored in ~/.hermes-web-ui/.token. Optional username/password login can be configured from the Settings page.',
      },
    },
  },
}
