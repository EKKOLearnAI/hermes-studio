export function extractClipboardFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return []

  const itemFiles = Array.from(clipboardData.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  const files = itemFiles.length > 0 ? itemFiles : Array.from(clipboardData.files || [])
  const pastedAt = Date.now()

  return files.map((file, index) => {
    if (!file.type.startsWith('image/')) return file
    const extension = file.type.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png'
    const suffix = index > 0 ? `-${index + 1}` : ''
    return new File([file], `pasted-${pastedAt}${suffix}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    })
  })
}
