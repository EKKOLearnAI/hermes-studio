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
