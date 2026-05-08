import { onMounted, onUnmounted } from 'vue'

export function useScrollReveal() {
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed')
            observer!.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
    )

    document.querySelectorAll('.reveal').forEach((el) => {
      observer!.observe(el)
    })
  })

  onUnmounted(() => {
    observer?.disconnect()
  })
}
