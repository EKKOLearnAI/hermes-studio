import {
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../services/hermes/authorized-provider-credentials'
import { configureAuthorizedProviderRuntime } from '../modules/studio/public/authorized-provider-runtime'

configureAuthorizedProviderRuntime({
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
})
