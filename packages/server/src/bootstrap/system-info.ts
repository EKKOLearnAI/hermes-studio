import { config } from '../config'
import * as hermesCli from '../services/hermes/hermes-cli'
import * as systemInfo from '../modules/studio/public/system-info'

systemInfo.configureSystemInfo({
  getAppHome: () => config.appHome,
  getHermesVersion: () => hermesCli.getVersion(),
})

export * from '../modules/studio/public/system-info'
