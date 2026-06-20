<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-left">
        <div class="footer-brand">
          <img src="/logo.png" :alt="t('brand.logoAlt')" class="footer-logo" />
          <span>{{ t('brand.name') }}</span>
        </div>
        <p class="footer-desc">{{ t('footer.description') }}</p>
      </div>
      <div class="footer-right">
        <p class="footer-meta">{{ t('footer.madeWith') }}</p>
        <p class="footer-meta">{{ t('footer.license') }}</p>
        <div class="footer-links">
          <a
            class="footer-social"
            href="https://github.com/EKKOLearnAI/hermes-studio"
            target="_blank"
            rel="noopener"
            :aria-label="t('footer.github')"
            :title="t('footer.github')"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
          <a
            class="footer-social"
            href="https://www.douyin.com/user/MS4wLjABAAAACnPvIrn4aFN7LGK5kCarDJzCHKGlnbWbfhTAyTIW7ITW7isoK48FntadaPkLjj9u"
            target="_blank"
            rel="noopener"
            :aria-label="t('footer.douyin')"
            :title="t('footer.douyin')"
          >
            <svg class="douyin-icon" viewBox="0 0 34 40" aria-hidden="true">
              <path class="douyin-cyan" d="M13.5 15.4v-1.5c-.5-.1-1.1-.1-1.6-.1C5.3 13.8 0 19.1 0 25.6c0 4 2 7.5 5.1 9.7-2-2.1-3.2-4.9-3.2-8C1.9 20.8 7.1 15.5 13.5 15.4Z" />
              <path class="douyin-cyan" d="M13.7 32.7c2.9 0 5.3-2.3 5.4-5.2V1.6h4.7c-.1-.5-.1-1.1-.1-1.6h-6.5v25.9c-.1 2.9-2.5 5.2-5.4 5.2-.9 0-1.8-.2-2.5-.6 1 1.4 2.6 2.2 4.4 2.2Z" />
              <path class="douyin-cyan" d="M32.7 10.4V9c-1.8 0-3.5-.5-4.9-1.5 1.3 1.5 3 2.5 4.9 2.9Z" />
              <path class="douyin-pink" d="M27.8 7.5c-1.4-1.6-2.2-3.6-2.2-5.9h-1.7c.5 2.4 1.9 4.5 3.9 5.9Z" />
              <path class="douyin-pink" d="M11.9 20.2c-3 0-5.4 2.4-5.4 5.4 0 2.1 1.2 3.9 2.9 4.8-.6-.9-1-2-1-3.2 0-3 2.4-5.4 5.4-5.4.5 0 1.1.1 1.6.3v-6.6c-.5-.1-1.1-.1-1.6-.1h-.3v5.1c-.5-.2-1-.3-1.6-.3Z" />
              <path class="douyin-pink" d="M32.7 10.4v5c-3.4 0-6.4-1.1-9-2.9v13.1c0 6.5-5.3 11.9-11.9 11.9-2.5 0-4.9-.8-6.8-2.2 2.2 2.3 5.3 3.8 8.7 3.8 6.5 0 11.9-5.3 11.9-11.9V14.1c2.5 1.8 5.6 2.9 9 2.9v-6.5c-.7 0-1.3-.1-1.9-.1Z" />
              <path class="douyin-black" d="M23.8 25.6V12.5c2.5 1.8 5.6 2.9 9 2.9v-5c-1.9-.4-3.6-1.5-4.9-2.9-2-1.3-3.5-3.4-3.9-5.9h-4.7v25.9c-.1 2.9-2.5 5.2-5.4 5.2-1.8 0-3.4-.9-4.4-2.3-1.7-.9-2.9-2.7-2.9-4.8 0-3 2.4-5.4 5.4-5.4.5 0 1.1.1 1.6.3v-5.1C7.1 15.5 1.9 20.8 1.9 27.2c0 3.1 1.2 6 3.2 8.1 1.9 1.3 4.3 2.1 6.8 2.1 6.6.1 11.9-5.2 11.9-11.8Z" />
            </svg>
          </a>
          <a
            class="footer-social xiaohongshu-social"
            href="https://xhslink.com/m/9fGP92Q87oh"
            target="_blank"
            rel="noopener"
            :aria-label="t('footer.xiaohongshu')"
            :title="t('footer.xiaohongshu')"
          >
            小红书
          </a>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.site-footer {
  padding: 0 18px 18px;
  background: #f7f8fa;

  @media (max-width: $breakpoint-mobile) {
    padding: 0 10px 10px;
  }
}

.footer-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 32px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 40px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.84);
  backdrop-filter: blur(14px);

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
    gap: 24px;
    padding: 22px 18px;
    border-radius: 22px;
  }
}

.footer-left {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 650;
  color: rgba(30, 38, 52, 0.9);
}

.footer-logo {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: #f7f4ef;
  border: 1px solid rgba(30, 50, 90, 0.08);
}

.footer-desc {
  color: rgba(42, 50, 64, 0.58);
  font-size: 13px;
}

.footer-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;

  @media (max-width: $breakpoint-mobile) {
    align-items: flex-start;
  }
}

.footer-meta {
  color: rgba(42, 50, 64, 0.58);
  font-size: 13px;
}

.footer-links {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-social {
  width: 36px;
  height: 36px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.6);
  color: rgba(30, 50, 90, 0.66);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform $transition-fast, color $transition-fast, border-color $transition-fast, background $transition-fast;

  &:hover {
    transform: translateY(-1px);
    color: rgba(30, 50, 90, 0.95);
    border-color: rgba(30, 50, 90, 0.18);
    background: rgba(255, 255, 255, 0.9);
  }

  svg {
    width: 18px;
    height: 18px;
  }
}

.douyin-icon {
  width: 19px;
  height: 19px;
}

.douyin-cyan {
  fill: #00f2ea;
}

.douyin-pink {
  fill: #ff004f;
}

.douyin-black {
  fill: rgba(30, 50, 90, 0.88);
}

.xiaohongshu-social {
  width: auto;
  min-width: 56px;
  padding: 0 12px;
  color: #ff2442;
  font-size: 12px;
  font-weight: 750;
}
</style>
