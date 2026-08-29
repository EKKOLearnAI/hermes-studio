import { getTerminalConfig, validatePath } from '../modules/studio/services/files/file-provider'
import { getActiveProfileDir } from '../modules/hermes/services/profiles/profile'
import {
  configureLanPeerFilesystem,
} from '../modules/studio/services/network/lan-peer-socket'

import './system-info'

configureLanPeerFilesystem({ getActiveProfileDir, getTerminalConfig, validatePath })

export * from '../modules/studio/services/network/lan-peer-socket'
export * from '../modules/studio/services/network/lan-peer-tools'
