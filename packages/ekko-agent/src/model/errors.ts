export class ModelProviderError extends Error {
  readonly provider: string
  readonly statusCode?: number
  readonly retryable: boolean
  readonly details?: unknown

  constructor(
    message: string,
    options: {
      provider: string
      statusCode?: number
      retryable?: boolean
      details?: unknown
    },
  ) {
    super(message)
    this.name = 'ModelProviderError'
    this.provider = options.provider
    this.statusCode = options.statusCode
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500
}
