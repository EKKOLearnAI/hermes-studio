import {
  PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
} from '../services/config-helpers'
import * as hermesProfile from '../services/hermes/hermes-profile'
import { configureProfileConfig } from '../modules/studio/public/profile-config'

const hasProfileExport = (name: string): boolean => (
  Object.prototype.hasOwnProperty.call(hermesProfile, name)
)
const getProfilesBaseDir = hasProfileExport('getHermesBaseDir')
  ? (hermesProfile as any).getHermesBaseDir as () => string
  : () => hermesProfile.getProfileDir('default')
const listProfileNames = hasProfileExport('listProfileNamesFromDisk')
  ? (hermesProfile as any).listProfileNamesFromDisk as () => string[]
  : () => ['default']

configureProfileConfig({
  getProfilesBaseDir,
  getProfileDir: hermesProfile.getProfileDir,
  listProfileNames,
  providerEnvironmentMap: PROVIDER_ENV_MAP,
  readConfigYamlForProfile,
  safeReadFile,
})
