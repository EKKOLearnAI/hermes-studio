import Router from '@koa/router'
import { getLlmSchedulerTelemetry } from '../../services/hermes/llm-scheduler'

export const auroraComputeLoadRoutes = new Router()

auroraComputeLoadRoutes.get('/api/aurora/compute-load', async (ctx) => {
  ctx.body = getLlmSchedulerTelemetry()
})
