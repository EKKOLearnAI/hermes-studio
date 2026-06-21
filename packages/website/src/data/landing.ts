export type ServiceStatus = 'public' | 'restricted' | 'admin' | 'review'

export interface ServiceItem {
  name: string
  subdomain: string
  href: string
  description: string
  status: ServiceStatus
  access: string
  tags: string[]
  featured?: boolean
}

export interface ServiceGroup {
  id: string
  title: string
  summary: string
  accent: string
  accentSoft: string
  items: ServiceItem[]
}

export const heroPillars = [
  'PromptLab',
  'TACO',
  'UNESP/Bauru',
  'Robótica EM',
  'Self-hosted',
] as const

export const statusLabels: Record<ServiceStatus, string> = {
  public: 'Público',
  restricted: 'Restrito',
  admin: 'Admin',
  review: 'Em revisão',
}

export const serviceGroups: ServiceGroup[] = [
  {
    id: 'ia-e-agentes',
    title: 'IA e agentes',
    summary: 'Espaços para uso diário de modelos, sessões e integrações mais técnicas.',
    accent: '#7c8cff',
    accentSoft: 'rgba(124, 140, 255, 0.16)',
    items: [
      {
        name: 'Hermes Studio',
        subdomain: 'hermes.paulocavallari.tech',
        href: 'https://hermes.paulocavallari.tech',
        description: 'Console central para conversar com agentes, rever sessões e tocar automações do dia a dia.',
        status: 'restricted',
        access: 'Uso diário',
        tags: ['IA', 'Agentes', 'Sessões'],
        featured: true,
      },
      {
        name: 'GPT Interface',
        subdomain: 'gpt.paulocavallari.tech',
        href: 'https://gpt.paulocavallari.tech',
        description: 'Atalho rápido para consultas curtas, rascunhos e tarefas de resposta imediata.',
        status: 'restricted',
        access: 'Atalho rápido',
        tags: ['IA', 'Prompt', 'Rascunho'],
        featured: true,
      },
      {
        name: 'MCP Server',
        subdomain: 'mcp.paulocavallari.tech',
        href: 'https://mcp.paulocavallari.tech',
        description: 'Ponte técnica para ferramentas, integrações e serviços que conversam com o ecossistema.',
        status: 'admin',
        access: 'Integrações técnicas',
        tags: ['IA', 'Ferramentas', 'Integração'],
      },
      {
        name: 'Kiro',
        subdomain: 'kiro.paulocavallari.tech',
        href: 'https://kiro.paulocavallari.tech',
        description: 'Ambiente auxiliar para experimentos, testes e validações locais.',
        status: 'restricted',
        access: 'Experimentação',
        tags: ['IA', 'Experimentos', 'Validação'],
      },
      {
        name: 'AAR',
        subdomain: 'aar.paulocavallari.tech',
        href: 'https://aar.paulocavallari.tech',
        description: 'Espaço de apoio para leitura, anotações e consultas rápidas de pesquisa.',
        status: 'restricted',
        access: 'Pesquisa e apoio',
        tags: ['IA', 'Pesquisa', 'Notas'],
      },
    ],
  },
  {
    id: 'produtividade-e-arquivos',
    title: 'Produtividade e arquivos',
    summary: 'Arquivos, documentos e áreas de trabalho organizados para o fluxo cotidiano.',
    accent: '#14b8a6',
    accentSoft: 'rgba(20, 184, 166, 0.16)',
    items: [
      {
        name: 'Drive',
        subdomain: 'drive.paulocavallari.tech',
        href: 'https://drive.paulocavallari.tech',
        description: 'Arquivos, materiais e entregas organizados com acesso simples e direto.',
        status: 'restricted',
        access: 'Arquivos pessoais',
        tags: ['Arquivos', 'Materiais', 'Organização'],
        featured: true,
      },
      {
        name: 'PDF Tools',
        subdomain: 'pdf.paulocavallari.tech',
        href: 'https://pdf.paulocavallari.tech',
        description: 'Tratamento leve de PDFs e documentos para revisão e distribuição.',
        status: 'restricted',
        access: 'Documentos',
        tags: ['Arquivos', 'PDF', 'Conversão'],
      },
      {
        name: 'Workspace',
        subdomain: 'workspace.paulocavallari.tech',
        href: 'https://workspace.paulocavallari.tech',
        description: 'Área de trabalho para projetos em andamento e conteúdos em construção.',
        status: 'restricted',
        access: 'Projetos em andamento',
        tags: ['Arquivos', 'Projetos', 'Rascunhos'],
        featured: true,
      },
    ],
  },
  {
    id: 'infraestrutura-e-acesso',
    title: 'Infraestrutura e acesso',
    summary: 'Visão operacional, autenticação, terminal e notificações do ambiente.',
    accent: '#f97316',
    accentSoft: 'rgba(249, 115, 22, 0.16)',
    items: [
      {
        name: 'Dashboard',
        subdomain: 'dashboard.paulocavallari.tech',
        href: 'https://dashboard.paulocavallari.tech',
        description: 'Visão geral da infraestrutura, dos serviços e do que precisa atenção.',
        status: 'admin',
        access: 'Visão operacional',
        tags: ['Infra', 'Status', 'Admin'],
      },
      {
        name: 'Autenticação',
        subdomain: 'auth.paulocavallari.tech',
        href: 'https://auth.paulocavallari.tech',
        description: 'Entrada central e controles de acesso para os serviços do domínio.',
        status: 'admin',
        access: 'Controle de acesso',
        tags: ['Infra', 'Login', 'Segurança'],
      },
      {
        name: 'Terminal Web',
        subdomain: 'terminal.paulocavallari.tech',
        href: 'https://terminal.paulocavallari.tech',
        description: 'Acesso operacional para manutenção, inspeção e suporte remoto.',
        status: 'admin',
        access: 'Manutenção',
        tags: ['Infra', 'Shell', 'Admin'],
      },
      {
        name: 'Ntfy',
        subdomain: 'ntfy.paulocavallari.tech',
        href: 'https://ntfy.paulocavallari.tech',
        description: 'Alertas e notificações instantâneas para eventos importantes.',
        status: 'admin',
        access: 'Alertas',
        tags: ['Infra', 'Alertas', 'Notificações'],
      },
    ],
  },
  {
    id: 'comunicacao-e-automacao',
    title: 'Comunicação e automação',
    summary: 'Integrações e rotas de comunicação que sustentam automações do ecossistema.',
    accent: '#f59e0b',
    accentSoft: 'rgba(245, 158, 11, 0.16)',
    items: [
      {
        name: 'Evolution API',
        subdomain: 'evo.paulocavallari.tech',
        href: 'https://evo.paulocavallari.tech',
        description: 'Integrações de comunicação e automações externas em um ponto só.',
        status: 'restricted',
        access: 'Automação',
        tags: ['Comunicação', 'Automação', 'Integração'],
      },
    ],
  },
  {
    id: 'seguranca',
    title: 'Segurança',
    summary: 'Senhas, segredos e credenciais sob controle pessoal e acesso protegido.',
    accent: '#ef4444',
    accentSoft: 'rgba(239, 68, 68, 0.16)',
    items: [
      {
        name: 'Vaultwarden',
        subdomain: 'vault.paulocavallari.tech',
        href: 'https://vault.paulocavallari.tech',
        description: 'Senhas, chaves e credenciais com foco em privacidade e acesso protegido.',
        status: 'restricted',
        access: 'Segredos e credenciais',
        tags: ['Segurança', 'Segredos', 'Privacidade'],
        featured: true,
      },
    ],
  },
  {
    id: 'lazer-e-comunidades',
    title: 'Lazer e comunidades',
    summary: 'Espaços com identidade própria e uso mais descontraído.',
    accent: '#22c55e',
    accentSoft: 'rgba(34, 197, 94, 0.16)',
    items: [
      {
        name: 'Minecraft Console',
        subdomain: 'mcsm.paulocavallari.tech',
        href: 'https://mcsm.paulocavallari.tech',
        description: 'Gerenciamento do servidor e comandos administrativos do ambiente de jogo.',
        status: 'admin',
        access: 'Servidor e comandos',
        tags: ['Lazer', 'Servidor', 'Admin'],
      },
      {
        name: 'Sandwolves',
        subdomain: 'sandwolves.paulocavallari.tech',
        href: 'https://sandwolves.paulocavallari.tech',
        description: 'Projeto com identidade própria e presença pública no domínio.',
        status: 'public',
        access: 'Projeto público',
        tags: ['Lazer', 'Comunidade', 'Público'],
      },
    ],
  },
  {
    id: 'a-confirmar',
    title: 'A confirmar',
    summary: 'Entradas ainda em validação antes de entrar de vez no hub principal.',
    accent: '#94a3b8',
    accentSoft: 'rgba(148, 163, 184, 0.2)',
    items: [
      {
        name: 'DevSpace',
        subdomain: 'devspace.paulocavallari.tech',
        href: 'https://devspace.paulocavallari.tech',
        description: 'Entrada em validação antes de virar mais um ponto estável do ecossistema.',
        status: 'review',
        access: 'Em validação',
        tags: ['Revisão', 'DNS', 'Pendente'],
      },
    ],
  },
]

export const landingNotes = [
  'Serviços administrativos continuam protegidos por autenticação própria.',
  'A ordenação privilegia uso diário e leitura rápida, não hierarquia técnica.',
  'Entradas em revisão ficam isoladas para evitar ruído no fluxo principal.',
]
