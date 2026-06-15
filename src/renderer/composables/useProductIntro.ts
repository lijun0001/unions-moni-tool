import { ref } from 'vue'

const introOpen = ref(false)
const introTitle = ref('')
const introMarkdown = ref('')

export function useProductIntro() {
  function hasProductIntro(markdown?: string) {
    return Boolean(markdown?.trim())
  }

  function openProductIntro(title: string, markdown?: string) {
    const md = markdown?.trim()
    if (!md) return
    introTitle.value = title
    introMarkdown.value = md
    introOpen.value = true
  }

  return {
    introOpen,
    introTitle,
    introMarkdown,
    hasProductIntro,
    openProductIntro,
  }
}
