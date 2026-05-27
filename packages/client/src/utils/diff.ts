export function isUnifiedDiff(content: string): boolean {
  return /^(---|\+\+\+|@@ |diff )/.test(content.trim())
}
