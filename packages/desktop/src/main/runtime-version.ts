export type RuntimeManifestVersionMetadata = {
  hermesAgentVersion?: string
  asset?: {
    name?: string
  }
}

export function hermesAgentVersionFromRuntimeTag(tag?: string | null): string | null {
  const value = tag?.trim()
  if (!value) return null
  const match = value.match(/^hermes-(.+)-runtime$/)
  return match?.[1] || null
}

export function runtimeManifestMatchesHermesAgentVersion(
  manifest: RuntimeManifestVersionMetadata | null,
  expectedVersion: string,
): boolean | null {
  if (!manifest) return null
  if (manifest.hermesAgentVersion) return manifest.hermesAgentVersion === expectedVersion
  const assetName = manifest.asset?.name
  if (assetName) return assetName.includes(`hermes-agent-${expectedVersion}-`)
  return null
}

export function compareHermesAgentVersions(left?: string | null, right?: string | null): number | null {
  const leftValue = left?.trim().replace(/^v/, '')
  const rightValue = right?.trim().replace(/^v/, '')
  if (!leftValue || !rightValue) return null

  const leftParts = leftValue.split(/[.-]/).map(part => Number.parseInt(part, 10))
  const rightParts = rightValue.split(/[.-]/).map(part => Number.parseInt(part, 10))
  if (leftParts.some(Number.isNaN) || rightParts.some(Number.isNaN)) {
    return leftValue.localeCompare(rightValue, undefined, { numeric: true })
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
