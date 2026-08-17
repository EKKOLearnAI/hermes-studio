<script setup lang="ts">
import { watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'

const { locale, t } = useI18n()

const sections = [
  { key: 'information', number: '01', paragraphs: 2 },
  { key: 'use', number: '02', paragraphs: 1 },
  { key: 'google', number: '03', paragraphs: 3 },
  { key: 'processing', number: '04', paragraphs: 2 },
  { key: 'sharing', number: '05', paragraphs: 1 },
  { key: 'retention', number: '06', paragraphs: 2 },
  { key: 'security', number: '07', paragraphs: 1 },
  { key: 'rights', number: '08', paragraphs: 1 },
  { key: 'children', number: '09', paragraphs: 2 },
  { key: 'updates', number: '10', paragraphs: 2 },
] as const

function switchLocale() {
  const next = locale.value === 'en' ? 'zh' : 'en'
  locale.value = next
  localStorage.setItem('hermes_website_locale', next)
}

watchEffect(() => {
  document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en'
  document.title = t('privacy.browserTitle')
})
</script>

<template>
  <div class="privacy-page">
    <header class="masthead">
      <a class="brand" href="/" :aria-label="t('privacy.homeLabel')">
        <span class="brand-mark">
          <img src="/logo.png" alt="" width="43" height="43" />
        </span>
        <span class="brand-copy">
          <strong>{{ t('brand.name') }}</strong>
          <small>AGENT WORKSPACE</small>
        </span>
      </a>
      <div class="masthead-actions">
        <span class="document-tag">{{ t('privacy.documentTag') }}</span>
        <button class="language-button" type="button" @click="switchLocale">
          {{ locale === 'en' ? '中' : 'EN' }}
        </button>
      </div>
    </header>

    <main>
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy">
          <p class="eyebrow">{{ t('privacy.eyebrow') }}</p>
          <h1 id="page-title">{{ t('privacy.title') }}</h1>
          <p class="lede">{{ t('privacy.lede') }}</p>
        </div>
        <dl class="metadata">
          <div>
            <dt>{{ t('privacy.effectiveDateLabel') }}</dt>
            <dd>{{ t('privacy.effectiveDate') }}</dd>
          </div>
          <div>
            <dt>{{ t('privacy.productLabel') }}</dt>
            <dd>{{ t('privacy.product') }}</dd>
          </div>
          <div>
            <dt>{{ t('privacy.developerLabel') }}</dt>
            <dd>{{ t('privacy.developer') }}</dd>
          </div>
          <div>
            <dt>{{ t('privacy.contactLabel') }}</dt>
            <dd>
              <a href="mailto:hermes.studio.ai@gmail.com">{{ t('privacy.contactEmail') }}</a>
            </dd>
          </div>
        </dl>
      </section>

      <div class="policy-layout">
        <aside class="index" :aria-label="t('privacy.contents')">
          <p>{{ t('privacy.contents') }}</p>
          <ol>
            <li v-for="section in sections" :key="section.key">
              <a :href="`#section-${section.number}`">
                <span>{{ section.number }}</span>
                {{ t(`privacy.sections.${section.key}.title`) }}
              </a>
            </li>
          </ol>
        </aside>

        <article class="policy">
          <div class="notice">
            <strong>{{ t('privacy.noticeTitle') }}</strong>
            <p>{{ t('privacy.noticeBody') }}</p>
          </div>

          <section
            v-for="section in sections"
            :id="`section-${section.number}`"
            :key="section.key"
            class="policy-section"
          >
            <span class="section-number" aria-hidden="true">{{ section.number }}</span>
            <div>
              <h2>{{ t(`privacy.sections.${section.key}.title`) }}</h2>
              <p v-for="paragraphIndex in section.paragraphs" :key="paragraphIndex">
                {{ t(`privacy.sections.${section.key}.paragraphs.${paragraphIndex - 1}`) }}
              </p>

              <div v-if="section.key === 'google'" class="policy-links">
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ t('privacy.googlePolicyLink') }}
                </a>
              </div>

              <div v-if="section.key === 'retention'" class="policy-links">
                <a
                  href="https://myaccount.google.com/permissions"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ t('privacy.googlePermissionsLink') }}
                </a>
              </div>

              <a
                v-if="section.key === 'updates'"
                class="contact-link"
                href="mailto:hermes.studio.ai@gmail.com"
              >
                {{ t('privacy.contactAction') }}
              </a>
            </div>
          </section>
        </article>
      </div>
    </main>

    <footer class="privacy-footer">
      <p>{{ t('privacy.copyright') }}</p>
      <a href="#page-title">{{ t('privacy.backToTop') }}</a>
    </footer>
  </div>
</template>

<style scoped lang="scss">
:global(html) {
  scroll-behavior: smooth;
}

:global(body) {
  margin: 0;
  background: #f2f0e8;
}

.privacy-page {
  --privacy-ink: #17201d;
  --privacy-muted: #65706a;
  --privacy-paper: #f2f0e8;
  --privacy-sheet: #fbfaf5;
  --privacy-line: #cbc8ba;
  --privacy-moss: #1f5142;
  --privacy-acid: #d8e878;

  min-height: 100vh;
  color: var(--privacy-ink);
  background: var(--privacy-paper);
  font-family: "Songti SC", "STSong", "Noto Serif CJK SC", Georgia, serif;
  text-rendering: optimizeLegibility;
}

.masthead {
  min-height: 92px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px clamp(24px, 5vw, 76px);
  border-bottom: 1px solid var(--privacy-line);
  background: rgba(242, 240, 232, 0.94);
}

.brand {
  display: flex;
  align-items: center;
  gap: 13px;
  color: inherit;
  text-decoration: none;
}

.brand-mark {
  width: 48px;
  height: 48px;
  overflow: hidden;
  flex: 0 0 auto;
  background: #fff;
  border: 1px solid var(--privacy-line);
  border-radius: 8px;
  box-shadow: 0 2px 0 rgba(23, 32, 29, 0.12);
}

.brand-mark img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.brand-copy strong {
  display: block;
  font-family: Georgia, serif;
  font-size: 18px;
}

.brand-copy small,
.document-tag,
.eyebrow,
.index,
dt {
  font-family: "Avenir Next Condensed", "DIN Condensed", sans-serif;
  letter-spacing: 0.08em;
}

.brand-copy small {
  display: block;
  margin-top: 3px;
  color: var(--privacy-muted);
  font-size: 9px;
}

.masthead-actions {
  display: flex;
  align-items: center;
  gap: 18px;
}

.document-tag {
  color: var(--privacy-muted);
  font-size: 11px;
}

.language-button {
  width: 40px;
  height: 36px;
  border: 1px solid var(--privacy-line);
  border-radius: 6px;
  background: var(--privacy-sheet);
  color: var(--privacy-ink);
  cursor: pointer;
  font: 700 12px/1 "Avenir Next", sans-serif;
}

.language-button:hover,
.language-button:focus-visible {
  border-color: var(--privacy-moss);
  outline: none;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.7fr);
  gap: clamp(48px, 8vw, 130px);
  padding: clamp(64px, 10vw, 140px) clamp(24px, 8vw, 124px) clamp(68px, 9vw, 126px);
  background:
    radial-gradient(circle at 88% 20%, rgba(216, 232, 120, 0.42) 0 8%, transparent 28%),
    linear-gradient(125deg, var(--privacy-sheet) 0 68%, #e4e6d8 68%);
  border-bottom: 1px solid var(--privacy-line);
}

.eyebrow {
  margin: 0 0 28px;
  color: var(--privacy-moss);
  font-size: 12px;
}

h1 {
  margin: 0;
  font-size: clamp(58px, 9vw, 132px);
  font-weight: 700;
  line-height: 0.9;
  letter-spacing: 0;
}

.lede {
  max-width: 760px;
  margin: 42px 0 0;
  color: var(--privacy-muted);
  font-size: clamp(18px, 2vw, 26px);
  line-height: 1.75;
}

.metadata {
  align-self: end;
  margin: 0;
  border-top: 3px solid var(--privacy-ink);
}

.metadata div {
  padding: 16px 0 17px;
  border-bottom: 1px solid var(--privacy-line);
}

dt {
  color: var(--privacy-muted);
  font-size: 10px;
  text-transform: uppercase;
}

dd {
  margin: 8px 0 0;
  font-size: 15px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

dd a {
  color: inherit;
  text-decoration-color: var(--privacy-moss);
  text-underline-offset: 4px;
}

.policy-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 820px);
  gap: clamp(55px, 8vw, 130px);
  justify-content: center;
  padding: clamp(64px, 8vw, 120px) 24px;
}

.index {
  position: sticky;
  top: 28px;
  align-self: start;
  font-size: 11px;
}

.index p {
  margin: 0 0 20px;
  color: var(--privacy-moss);
}

.index ol {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--privacy-line);
}

.index li {
  border-bottom: 1px solid var(--privacy-line);
}

.index a {
  display: flex;
  gap: 8px;
  padding: 11px 0;
  color: var(--privacy-muted);
  text-decoration: none;
  letter-spacing: 0;
  transition: color 0.2s, transform 0.2s;
}

.index a:hover,
.index a:focus-visible {
  color: var(--privacy-ink);
  transform: translateX(5px);
}

.index a span {
  color: var(--privacy-moss);
}

.notice {
  margin-bottom: 66px;
  padding: 27px 30px 30px;
  background: var(--privacy-moss);
  color: #f7f4e8;
  border-radius: 2px 8px 2px 2px;
}

.notice strong {
  font-size: 20px;
}

.notice p {
  margin: 10px 0 0;
  color: #d9e4dc;
  font-size: 15px;
  line-height: 1.9;
}

.policy-section {
  scroll-margin-top: 24px;
  display: grid;
  grid-template-columns: 58px 1fr;
  gap: 18px;
  padding: 0 0 58px;
  margin-bottom: 58px;
  border-bottom: 1px solid var(--privacy-line);
}

.section-number {
  padding-top: 8px;
  color: var(--privacy-moss);
  font: 700 12px/1 "Avenir Next Condensed", sans-serif;
}

h2 {
  margin: 0 0 24px;
  font-size: clamp(27px, 3.3vw, 42px);
  line-height: 1.2;
  letter-spacing: 0;
}

.policy-section p {
  margin: 0 0 18px;
  color: #4f5954;
  font-size: 18px;
  line-height: 2.05;
}

.policy-links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 22px;
}

.policy-links a {
  color: var(--privacy-moss);
  font: 700 14px/1.5 "Avenir Next", sans-serif;
  text-underline-offset: 4px;
}

.contact-link {
  display: inline-block;
  margin-top: 8px;
  padding: 13px 18px;
  border: 1px solid var(--privacy-ink);
  background: var(--privacy-acid);
  color: var(--privacy-ink);
  box-shadow: 4px 4px 0 var(--privacy-ink);
  font-weight: 700;
  text-decoration: none;
  transition: transform 0.18s, box-shadow 0.18s;
}

.contact-link:hover,
.contact-link:focus-visible {
  transform: translate(3px, 3px);
  box-shadow: 1px 1px 0 var(--privacy-ink);
}

.privacy-footer {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 32px clamp(24px, 8vw, 124px);
  background: var(--privacy-ink);
  color: #dce3dc;
  font: 12px/1.4 "Avenir Next Condensed", sans-serif;
  letter-spacing: 0.04em;
}

.privacy-footer p {
  margin: 0;
}

.privacy-footer a {
  color: var(--privacy-acid);
  text-decoration: none;
}

@media (max-width: 840px) {
  .hero {
    grid-template-columns: 1fr;
    background:
      radial-gradient(circle at 90% 12%, rgba(216, 232, 120, 0.48), transparent 30%),
      var(--privacy-sheet);
  }

  .metadata {
    max-width: 520px;
  }

  .policy-layout {
    display: block;
  }

  .index {
    display: none;
  }
}

@media (max-width: 540px) {
  .masthead {
    min-height: 76px;
  }

  .document-tag,
  .brand-copy small {
    display: none;
  }

  .hero {
    padding-top: 58px;
  }

  h1 {
    font-size: 54px;
  }

  .lede {
    margin-top: 28px;
    font-size: 17px;
  }

  .policy-layout {
    padding-top: 48px;
  }

  .notice {
    margin-bottom: 48px;
    padding: 23px;
  }

  .policy-section {
    grid-template-columns: 38px 1fr;
    gap: 6px;
    padding-bottom: 40px;
    margin-bottom: 40px;
  }

  .policy-section p {
    font-size: 16px;
    line-height: 1.95;
  }

  .privacy-footer {
    display: block;
  }

  .privacy-footer a {
    display: inline-block;
    margin-top: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(html) {
    scroll-behavior: auto;
  }

  * {
    transition: none !important;
  }
}
</style>
