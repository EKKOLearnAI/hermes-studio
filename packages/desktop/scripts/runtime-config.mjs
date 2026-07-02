export const DEFAULT_HERMES_VERSION = '0.18.0'

export function hermesVersion(env = process.env) {
  return env.HERMES_VERSION || DEFAULT_HERMES_VERSION
}

export function runtimeReleaseTag(env = process.env) {
  const version = hermesVersion(env)
  return env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
    || env.RUNTIME_RELEASE_TAG
    || `hermes-${version}-runtime`
}
