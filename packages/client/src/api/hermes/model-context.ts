import { request } from '../client'

export interface ModelContext {
  id: number
  provider: string
  model: string
  context_limit: number
}

/**
 * 根据 provider 和 model 查询模型上下文配置
 */
export async function getModelContext(provider: string, model: string): Promise<ModelContext | null> {
  try {
    const res = await request<{ data: ModelContext }>(
      `/api/hermes/model-context?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
    )
    return res.data
  } catch (err: any) {
    if (err.status === 404) return null
    throw err
  }
}

/**
 * 设置模型上下文配置（UPSERT：存在则更新，不存在则插入）
 */
export async function setModelContext(
  provider: string,
  model: string,
  contextLimit: number
): Promise<ModelContext> {
  const res = await request<{ success: boolean; data: ModelContext }>(
    `/api/hermes/model-context/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ provider, model, context_limit: contextLimit }),
    }
  )
  return res.data
}
