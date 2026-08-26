import { getTerminalConfig, validatePath } from '../services/hermes/file-provider'
import { getActiveProfileDir } from '../services/hermes/hermes-profile'
import {
  configureLanPeerFilesystem,
} from '../modules/studio/services/network/lan-peer-socket'

import './system-info'

configureLanPeerFilesystem({ getActiveProfileDir, getTerminalConfig, validatePath })

export * from '../modules/studio/services/network/lan-peer-socket'
export * from '../modules/studio/services/network/lan-peer-tools'
