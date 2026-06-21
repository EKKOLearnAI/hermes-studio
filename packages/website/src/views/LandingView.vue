<script setup lang="ts">
import { computed, ref } from 'vue'
import { heroPillars, serviceGroups, statusLabels } from '@/data/landing'

const search = ref('')

function normalizeText(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

const normalizedQuery = computed(() => normalizeText(search.value.trim()))

const featuredServices = computed(() =>
  serviceGroups.flatMap((group) => group.items).filter((item) => item.featured),
)

const primaryFeatured = computed(() => featuredServices.value[0])

const totalServices = computed(() =>
  serviceGroups.reduce((total, group) => total + group.items.length, 0),
)

const filteredGroups = computed(() => {
  if (!normalizedQuery.value) {
    return serviceGroups
  }

  return serviceGroups
    .map((group) => {
      const items = group.items.filter((item) => {
        const haystack = [
          group.title,
          group.summary,
          item.name,
          item.subdomain,
          item.description,
          item.access,
          statusLabels[item.status],
          ...item.tags,
        ]
          .map(normalizeText)
          .join(' ')

        return haystack.includes(normalizedQuery.value)
      })

      return {
        ...group,
        items,
      }
    })
    .filter((group) => group.items.length > 0)
})

const visibleServices = computed(() =>
  filteredGroups.value.reduce((total, group) => total + group.items.length, 0),
)

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="landing-page">
    <section class="hero-section">
      <div class="hero-orb hero-orb--one" aria-hidden="true" />
      <div class="hero-orb hero-orb--two" aria-hidden="true" />

      <div class="hero-surface">
        <header class="hero-topbar">
          <div class="brand-block">
            <div class="brand-mark" aria-hidden="true">PC</div>
            <div class="brand-copy">
              <p class="brand-kicker">Hub pessoal</p>
              <h1 class="brand-name">Paulo Cavallari Tech</h1>
            </div>
          </div>

          <RouterLink class="docs-link" :to="{ name: 'docs.getting-started' }">
            <span>Documentação técnica do Hermes Studio</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M7 17 17 7" />
              <path d="M9 7h8v8" />
            </svg>
          </RouterLink>
        </header>

        <div class="hero-grid">
          <div class="hero-copy">
            <p class="hero-eyebrow">Docência • mestrado • IA generativa • automações</p>
            <h2 class="hero-title">Hub de IA, docência, pesquisa e infraestrutura soberana.</h2>
            <p class="hero-desc">
              Um painel único para acessar serviços, automações e ferramentas do ecossistema de Paulo, com nomes
              curtos, agrupamento claro e foco em uso diário.
            </p>

            <div class="hero-pill-row" aria-label="Pilares do hub">
              <span v-for="pillar in heroPillars" :key="pillar" class="hero-pill">{{ pillar }}</span>
            </div>

            <div class="hero-actions">
              <button type="button" class="primary-action" @click="scrollToSection('services')">
                Explorar serviços
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M9 7h8v8" />
                </svg>
              </button>

              <a
                v-if="primaryFeatured"
                class="secondary-action"
                :href="primaryFeatured.href"
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir {{ primaryFeatured.name }}
              </a>
            </div>

            <p class="hero-note">
              Listagem pensada para leitura rápida: entradas mais usadas primeiro, serviços administrativos marcados
              como restritos e itens em revisão isolados.
            </p>
          </div>

          <aside class="hero-panel">
            <article class="panel-card panel-card--featured">
              <div class="panel-head">
                <div>
                  <p class="panel-kicker">Atalhos principais</p>
                  <h3 class="panel-title">Entradas mais usadas no dia a dia</h3>
                </div>
                <span class="panel-badge">{{ featuredServices.length }} ações rápidas</span>
              </div>

              <div class="featured-grid">
                <a
                  v-for="item in featuredServices"
                  :key="item.subdomain"
                  class="featured-link"
                  :href="item.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="`Abrir ${item.name} em nova aba`"
                >
                  <span class="featured-icon" aria-hidden="true">{{ item.name.slice(0, 2).toUpperCase() }}</span>
                  <span class="featured-copy">
                    <strong>{{ item.name }}</strong>
                    <small>{{ item.access }}</small>
                  </span>
                </a>
              </div>
            </article>
          </aside>
        </div>
      </div>
    </section>

    <section class="content-shell">
      <div class="page-inner">
        <div class="section-head">
          <div class="section-copy">
            <p class="section-kicker">Mapa do ecossistema</p>
            <h2 class="section-title">Todos os serviços organizados por finalidade.</h2>
            <p class="section-desc">
              Clique para abrir em nova aba. Serviços administrativos continuam protegidos por autenticação própria.
            </p>
          </div>

          <div class="search-card">
            <label class="search-label" for="service-search">Filtrar serviços</label>
            <div class="search-field">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                id="service-search"
                v-model="search"
                type="search"
                aria-label="Filtrar serviços ou subdomínios"
                placeholder="Hermes, Vault, infra, arquivos..."
              />
              <button v-if="search" type="button" class="clear-search" @click="search = ''">Limpar</button>
            </div>
            <p class="search-summary">
              <strong>{{ visibleServices }}</strong> de <strong>{{ totalServices }}</strong> serviços
              <span v-if="search"> para “{{ search }}”</span>
            </p>
          </div>
        </div>

        <template v-if="filteredGroups.length">
          <section
            v-for="group in filteredGroups"
            :id="group.id"
            :key="group.id"
            class="group-card"
            :style="{ '--group-accent': group.accent, '--group-accent-soft': group.accentSoft }"
          >
            <header class="group-header">
              <div>
                <p class="group-kicker">{{ group.title }}</p>
                <p class="group-summary">{{ group.summary }}</p>
              </div>
              <span class="group-count">{{ group.items.length }} itens</span>
            </header>

            <div
              class="service-grid"
              :class="{
                'service-grid--single': group.items.length === 1,
                'service-grid--double': group.items.length === 2,
                'service-grid--triple': group.items.length >= 3,
              }"
            >
              <a
                v-for="item in group.items"
                :key="item.subdomain"
                class="service-card"
                :class="[`service-card--${item.status}`, { 'service-card--featured': item.featured } ]"
                :href="item.href"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`Abrir ${item.name} em nova aba`"
              >
                <div class="service-card__top">
                  <span class="status-pill" :class="`status-pill--${item.status}`">
                    {{ statusLabels[item.status] }}
                  </span>
                  <span class="tag-pill">{{ item.tags[0] }}</span>
                </div>

                <div class="service-card__body">
                  <h3 class="service-name">{{ item.name }}</h3>
                  <code class="service-domain">{{ item.subdomain }}</code>
                  <p class="service-desc">{{ item.description }}</p>
                </div>

                <div class="service-meta">
                  <span class="service-access">{{ item.access }}</span>
                  <span class="service-arrow" aria-hidden="true">↗</span>
                </div>
              </a>
            </div>
          </section>
        </template>

        <div v-else class="empty-state">
          <h3>Nenhum serviço encontrado</h3>
          <p>Tente outro termo, como “Hermes”, “Vault”, “infra” ou “arquivos”.</p>
          <button type="button" class="empty-reset" @click="search = ''">Limpar busca</button>
        </div>

        <div class="notes-grid">
          <article class="note-card">
            <h3>Como usar este hub</h3>
            <ul>
              <li>Os serviços aparecem por finalidade, não por ordem técnica.</li>
              <li>Links administrativos continuam protegidos por autenticação própria.</li>
              <li>As entradas em revisão ficam isoladas para evitar ruído no fluxo principal.</li>
            </ul>
          </article>

          <article class="note-card note-card--accent">
            <h3>Fluxo recomendado</h3>
            <p>
              Abra o serviço desejado, autentique quando necessário e volte ao hub para seguir para a próxima tarefa.
            </p>
            <RouterLink class="note-link" :to="{ name: 'docs.getting-started' }">
              Ver documentação técnica do Hermes Studio
            </RouterLink>
          </article>
        </div>

        <footer class="landing-footer">
          <div>
            <p class="landing-footer__name">Paulo Augusto Lopes Cavallari</p>
            <p class="landing-footer__tag">
              Docência • IA generativa • Pesquisa aplicada • Infraestrutura soberana
            </p>
          </div>
          <p class="landing-footer__meta">
            Feito para uso diário, com acesso direto e sem dependências desnecessárias.
          </p>
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.landing-page {
  --landing-bg: #07111f;
  --landing-bg-soft: #0d1a2f;
  --landing-surface: #f4f7fc;
  --landing-card: rgba(255, 255, 255, 0.92);
  --landing-card-strong: #ffffff;
  --landing-text: #eef4ff;
  --landing-text-muted: rgba(238, 244, 255, 0.68);
  --landing-text-dark: #0f172a;
  --landing-text-soft: #526074;
  --landing-border: rgba(15, 23, 42, 0.1);
  --landing-border-strong: rgba(15, 23, 42, 0.16);
  min-height: 100%;
  overflow-x: clip;
  background: var(--landing-surface);
  color: var(--landing-text-dark);
}

.hero-section {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(124, 140, 255, 0.22), transparent 32%),
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.16), transparent 28%),
    linear-gradient(180deg, var(--landing-bg) 0%, var(--landing-bg-soft) 100%);
  color: var(--landing-text);
}

.hero-orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(32px);
  pointer-events: none;
}

.hero-orb--one {
  top: 12%;
  left: -6%;
  width: 280px;
  height: 280px;
  background: rgba(124, 140, 255, 0.14);
}

.hero-orb--two {
  top: 18%;
  right: -8%;
  width: 320px;
  height: 320px;
  background: rgba(20, 184, 166, 0.12);
}

.hero-surface {
  position: relative;
  z-index: 1;
  max-width: 1240px;
  margin: 0 auto;
  padding: 24px 24px 96px;
}

.hero-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 34px;
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.brand-mark {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(124, 140, 255, 0.95), rgba(20, 184, 166, 0.92));
  color: #fff;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.12em;
  box-shadow: 0 18px 42px rgba(11, 17, 31, 0.24);
}

.brand-copy {
  min-width: 0;
}

.brand-kicker,
.section-kicker,
.panel-kicker,
.group-kicker,
.search-label {
  margin: 0 0 4px;
  color: var(--landing-text-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.brand-name {
  margin: 0;
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.02em;
}

.docs-link {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--landing-text);
  font-size: 14px;
  font-weight: 600;
  backdrop-filter: blur(16px);
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;

  svg {
    width: 15px;
    height: 15px;
  }

  &:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.18);
  }
}

.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 24px;
  align-items: stretch;
}

.hero-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 20px 0 0;
}

.hero-eyebrow {
  margin: 0 0 14px;
  color: rgba(238, 244, 255, 0.78);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.hero-title {
  margin: 0;
  max-width: 13ch;
  font-size: clamp(3rem, 7vw, 5.6rem);
  line-height: 0.96;
  letter-spacing: -0.05em;
}

.hero-desc {
  margin: 22px 0 0;
  max-width: 62ch;
  color: var(--landing-text-muted);
  font-size: 17px;
  line-height: 1.7;
}

.hero-pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.hero-pill,
.panel-chip,
.tag-pill,
.group-count,
.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  white-space: nowrap;
}

.hero-pill {
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(238, 244, 255, 0.88);
  font-size: 12px;
  font-weight: 700;
}

.hero-pill-row {
  margin-top: 22px;
}

.hero-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.primary-action,
.secondary-action,
.empty-reset,
.note-link {
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.primary-action {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, #7c8cff, #14b8a6);
  color: #fff;
  font-size: 14px;
  font-weight: 750;
  cursor: pointer;
  box-shadow: 0 18px 38px rgba(11, 17, 31, 0.24);

  svg {
    width: 15px;
    height: 15px;
  }

  &:hover {
    transform: translateY(-1px);
  }
}

.secondary-action {
  display: inline-flex;
  align-items: center;
  padding: 14px 18px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--landing-text);
  font-size: 14px;
  font-weight: 700;
  backdrop-filter: blur(16px);

  &:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.18);
  }
}

.hero-note {
  margin: 18px 0 0;
  max-width: 62ch;
  color: rgba(238, 244, 255, 0.68);
  font-size: 14px;
  line-height: 1.7;
}

.hero-panel {
  display: grid;
  gap: 16px;
  align-content: start;
}

.panel-card {
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px);
}

.panel-card--featured {
  min-height: 100%;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.panel-badge {
  flex-shrink: 0;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(238, 244, 255, 0.84);
  font-size: 12px;
  font-weight: 700;
}

.featured-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.featured-link {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-height: 92px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--landing-text);

  &:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.09);
    border-color: rgba(255, 255, 255, 0.16);
  }
}

.featured-icon {
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(124, 140, 255, 0.95), rgba(20, 184, 166, 0.84));
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.featured-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;

  strong {
    font-size: 14px;
    font-weight: 750;
  }

  small {
    color: rgba(238, 244, 255, 0.68);
    font-size: 12px;
    line-height: 1.4;
  }
}

.panel-card--identity {
  color: var(--landing-text);
}

.panel-text {
  margin: 0;
  color: rgba(238, 244, 255, 0.82);
  font-size: 15px;
  line-height: 1.7;
}

.panel-text--strong {
  margin-top: 4px;
  color: var(--landing-text);
  font-weight: 700;
}

.panel-text--muted {
  margin-top: 8px;
  color: rgba(238, 244, 255, 0.72);
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 24px;
}

.stat-card {
  padding: 18px 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--landing-text);
  backdrop-filter: blur(12px);

  strong {
    display: block;
    font-size: 26px;
    line-height: 1;
    letter-spacing: -0.04em;
  }

  span {
    display: block;
    margin-top: 8px;
    color: rgba(238, 244, 255, 0.72);
    font-size: 13px;
  }
}

.content-shell {
  position: relative;
  z-index: 2;
  overflow: hidden;
  margin-top: -42px;
  border-radius: 34px 34px 0 0;
  background: linear-gradient(180deg, var(--landing-surface) 0%, #edf2f9 100%);
  box-shadow: 0 -36px 72px rgba(7, 17, 31, 0.24);
}

.content-shell::before {
  content: '';
  position: absolute;
  top: -72px;
  right: 0;
  left: 0;
  height: 72px;
  background: linear-gradient(180deg, rgba(237, 242, 249, 0) 0%, rgba(237, 242, 249, 0.96) 100%);
  pointer-events: none;
}

.page-inner {
  max-width: 1240px;
  margin: 0 auto;
  padding: 34px 24px 84px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.section-copy {
  max-width: 640px;
}

.section-title {
  margin: 0;
  color: var(--landing-text-dark);
  font-size: clamp(2rem, 3.2vw, 2.8rem);
  line-height: 1.05;
  letter-spacing: -0.05em;
}

.section-desc {
  margin: 14px 0 0;
  color: var(--landing-text-soft);
  font-size: 15px;
  line-height: 1.7;
}

.search-card {
  flex: 1;
  max-width: 420px;
  padding: 18px;
  border: 1px solid var(--landing-border);
  border-radius: 24px;
  background: var(--landing-card);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
}

.search-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border: 1px solid var(--landing-border-strong);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.92);

  svg {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    color: var(--landing-text-soft);
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 14px 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--landing-text-dark);
    font-size: 14px;

    &::placeholder {
      color: #91a0b5;
    }
  }
}

.clear-search {
  padding: 8px 12px;
  border: 1px solid var(--landing-border);
  border-radius: 999px;
  background: #fff;
  color: var(--landing-text-soft);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    border-color: #cbd5e1;
    color: var(--landing-text-dark);
  }
}

.search-summary {
  margin: 12px 4px 0;
  color: var(--landing-text-soft);
  font-size: 13px;

  strong {
    color: var(--landing-text-dark);
  }
}

.group-card {
  margin-top: 22px;
  padding: 22px;
  border: 1px solid var(--group-accent-soft);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.06);
}

.group-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 18px;
}

.group-kicker {
  margin-bottom: 6px;
  color: var(--group-accent);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.03em;
  text-transform: none;
}

.group-summary {
  margin: 0;
  color: var(--landing-text-soft);
  font-size: 14px;
  line-height: 1.6;
}

.group-count {
  padding: 9px 12px;
  border: 1px solid var(--group-accent-soft);
  background: rgba(255, 255, 255, 0.9);
  color: var(--group-accent);
  font-size: 12px;
  font-weight: 800;
}

.service-grid {
  display: grid;
  gap: 14px;
}

.service-grid--single {
  grid-template-columns: minmax(0, 1fr);
}

.service-grid--double {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.service-grid--triple {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.service-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 18px;
  min-height: 200px;
  padding: 18px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(245, 248, 252, 0.96));
  color: var(--landing-text-dark);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.05);

  &:hover {
    transform: translateY(-2px);
    border-color: rgba(15, 23, 42, 0.14);
    box-shadow: 0 16px 34px rgba(15, 23, 42, 0.08);
  }
}

.service-card--featured {
  border-color: var(--group-accent);
  box-shadow: 0 16px 40px var(--group-accent-soft);
}

.service-card--review {
  border-style: dashed;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.96), rgba(241, 245, 249, 0.96));
}

.service-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.status-pill,
.tag-pill {
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
}

.tag-pill {
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(15, 23, 42, 0.04);
  color: var(--landing-text-soft);
}

.status-pill--public {
  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.12);
  color: #0f7a54;
}

.status-pill--restricted {
  border: 1px solid rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.12);
  color: #9a5800;
}

.status-pill--admin {
  border: 1px solid rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.12);
  color: #b42318;
}

.status-pill--review {
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.service-card__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.service-name {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.03em;
}

.service-domain {
  display: inline-flex;
  width: fit-content;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
  color: var(--landing-text-soft);
  font-size: 12px;
  font-weight: 700;
  font-family: inherit;
}

.service-desc {
  margin: 0;
  color: var(--landing-text-soft);
  font-size: 14px;
  line-height: 1.65;
}

.service-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.service-access {
  color: var(--group-accent);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.service-arrow {
  color: var(--landing-text-soft);
  font-size: 20px;
  line-height: 1;
}

.empty-state {
  margin-top: 22px;
  padding: 28px;
  border: 1px dashed var(--landing-border-strong);
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.82);
  text-align: center;

  h3 {
    margin: 0 0 8px;
    color: var(--landing-text-dark);
    font-size: 20px;
  }

  p {
    margin: 0;
    color: var(--landing-text-soft);
    font-size: 14px;
  }
}

.empty-reset {
  margin-top: 16px;
  padding: 11px 16px;
  border: 1px solid var(--landing-border);
  border-radius: 999px;
  background: #fff;
  color: var(--landing-text-dark);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;

  &:hover {
    transform: translateY(-1px);
    border-color: #cbd5e1;
  }
}

.notes-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-top: 28px;
}

.note-card {
  padding: 22px;
  border: 1px solid var(--landing-border);
  border-radius: 24px;
  background: var(--landing-card);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);

  h3 {
    margin: 0;
    color: var(--landing-text-dark);
    font-size: 20px;
    letter-spacing: -0.03em;
  }

  p {
    margin: 12px 0 0;
    color: var(--landing-text-soft);
    font-size: 14px;
    line-height: 1.7;
  }

  ul {
    margin: 12px 0 0;
    padding-left: 18px;
    color: var(--landing-text-soft);
    font-size: 14px;
    line-height: 1.8;
  }
}

.note-card--accent {
  border-color: rgba(124, 140, 255, 0.2);
  background: linear-gradient(135deg, #0f172a, #13213d);
  color: var(--landing-text);

  h3,
  p {
    color: var(--landing-text);
  }
}

.note-link {
  display: inline-flex;
  margin-top: 14px;
  color: #c9d7ff;
  font-size: 14px;
  font-weight: 800;
  text-decoration: underline;
  text-underline-offset: 4px;

  &:hover {
    color: #ffffff;
  }
}

.landing-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--landing-border);
}

.landing-footer__name {
  margin: 0;
  color: var(--landing-text-dark);
  font-size: 15px;
  font-weight: 800;
}

.landing-footer__tag,
.landing-footer__meta {
  margin: 6px 0 0;
  color: var(--landing-text-soft);
  font-size: 13px;
  line-height: 1.7;
}

.landing-footer__meta {
  max-width: 28rem;
  text-align: right;
}

@media (max-width: 1100px) {
  .hero-grid {
    grid-template-columns: 1fr;
  }

  .hero-title {
    max-width: 16ch;
  }

  .hero-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .section-head {
    flex-direction: column;
  }

  .search-card {
    max-width: none;
    width: 100%;
  }
}

@media (max-width: 980px) {
  .service-grid--triple {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .service-grid--double,
  .service-grid--triple {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 820px) {
  .hero-surface {
    padding: 20px 16px 76px;
  }

  .hero-topbar {
    flex-direction: column;
    align-items: stretch;
  }

  .docs-link {
    width: 100%;
    justify-content: center;
  }

  .hero-copy {
    padding-top: 10px;
  }

  .hero-title {
    font-size: clamp(2.5rem, 11vw, 4rem);
  }

  .hero-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .content-shell {
    border-radius: 28px 28px 0 0;
    margin-top: -32px;
  }

  .page-inner {
    padding: 28px 16px 72px;
  }

  .notes-grid {
    grid-template-columns: 1fr;
  }

  .landing-footer {
    flex-direction: column;
    align-items: flex-start;
  }

  .landing-footer__meta {
    text-align: left;
  }
}

@media (max-width: 640px) {
  .hero-grid,
  .notes-grid,
  .hero-stats {
    gap: 12px;
  }

  .brand-name {
    font-size: 18px;
  }

  .hero-desc,
  .hero-note {
    font-size: 15px;
  }

  .panel-head,
  .group-header,
  .service-meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .group-card,
  .note-card,
  .search-card {
    padding: 18px;
  }

  .service-grid {
    grid-template-columns: 1fr;
  }

  .hero-stats {
    grid-template-columns: 1fr;
  }

  .panel-card,
  .service-card {
    border-radius: 22px;
  }
}
</style>
