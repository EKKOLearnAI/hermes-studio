import type { DropdownOption } from 'naive-ui'

interface CategoryOption {
  id: number
  name: string
}

interface BuildSessionCategoryMenuChildrenOptions {
  categories: readonly CategoryOption[]
  currentCategoryId: number | null | undefined
  uncategorizedLabel: string
  loadFailedLabel: string
  retryLabel: string
  loadFailed: boolean
  loading: boolean
}

export function buildSessionCategoryMenuChildren({
  categories,
  currentCategoryId,
  uncategorizedLabel,
  loadFailedLabel,
  retryLabel,
  loadFailed,
  loading,
}: BuildSessionCategoryMenuChildrenOptions): DropdownOption[] {
  if (loadFailed) {
    return [
      { label: loadFailedLabel, key: 'category:load-failed', disabled: true },
      { label: retryLabel, key: 'category:retry', disabled: loading },
    ]
  }

  return [
    {
      label: uncategorizedLabel,
      key: 'category:none',
      disabled: currentCategoryId == null,
    },
    ...categories.map(category => ({
      label: category.name,
      key: `category:${category.id}`,
      disabled: currentCategoryId === category.id,
    })),
  ]
}

export function resolveRecentSessionCategoryLabel(
  categoryId: number | null | undefined,
  categoryNames: ReadonlyMap<number, string>,
  loaded: boolean,
  loadFailed: boolean,
  uncategorizedLabel: string,
): string | undefined {
  if (!loaded || loadFailed) return undefined
  if (categoryId == null) return uncategorizedLabel
  return categoryNames.get(categoryId)
}
