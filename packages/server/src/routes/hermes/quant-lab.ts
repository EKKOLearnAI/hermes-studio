import Router from '@koa/router'
import type { Context } from 'koa'

export interface QuantLabStatusResponse {
  ok: true
  feature: 'quant-lab'
  status: 'foundation'
  capabilities: string[]
}

export const quantLabRoutes = new Router()

quantLabRoutes.get('/api/hermes/quant-lab/status', async (ctx: Context) => {
  const body: QuantLabStatusResponse = {
    ok: true,
    feature: 'quant-lab',
    status: 'foundation',
    capabilities: [
      'status',
    ],
  }

  ctx.body = body
})
