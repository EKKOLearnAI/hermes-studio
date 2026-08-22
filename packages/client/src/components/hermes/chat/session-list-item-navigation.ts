export type SessionNavigationAction = 'select' | 'native' | 'open-new'

function isModifiedSessionNavigation(event?: MouseEvent): boolean {
  return !!event && (
    event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || event.button !== 0
  )
}

export function resolveSessionNavigation(
  event: MouseEvent | undefined,
  interceptModifiedNavigation: boolean,
): SessionNavigationAction {
  if (!isModifiedSessionNavigation(event)) return 'select'
  return interceptModifiedNavigation ? 'open-new' : 'native'
}
