export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

export function formatChatTimestamp(
  timestamp: number | string | Date,
  options: { now?: Date; locale?: string | string[] } = {},
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const now = options.now || new Date()
  const locale = options.locale
  const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

  if (isSameLocalDay(date, now)) {
    return date.toLocaleTimeString(locale, timeOptions)
  }

  const dateOptions: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: '2-digit', day: '2-digit', ...timeOptions }
    : { year: 'numeric', month: '2-digit', day: '2-digit', ...timeOptions }

  return date.toLocaleString(locale, dateOptions)
}
