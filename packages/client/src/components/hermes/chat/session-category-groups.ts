export interface SessionCategoryLike {
  id: number;
  name: string;
}

export interface SessionCategoryAssignment {
  categoryId?: number | null;
}

export interface VisibleSessionCategoryGroup<T> {
  key: string;
  label: string;
  sessions: T[];
}

export function buildVisibleSessionCategoryGroups<T extends SessionCategoryAssignment>(
  categories: readonly SessionCategoryLike[],
  sessions: readonly T[],
  uncategorizedLabel: string,
): VisibleSessionCategoryGroup<T>[] {
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const groups = categories
    .map((category) => ({
      key: `category-${category.id}`,
      label: category.name,
      sessions: sessions.filter((session) => session.categoryId === category.id),
    }))
    .filter((group) => group.sessions.length > 0);
  const uncategorized = sessions.filter(
    (session) => session.categoryId == null || !knownCategoryIds.has(session.categoryId),
  );
  if (uncategorized.length > 0) {
    groups.push({
      key: "category-none",
      label: uncategorizedLabel,
      sessions: uncategorized,
    });
  }
  return groups;
}
