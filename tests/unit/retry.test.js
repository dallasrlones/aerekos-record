const RetryManager = require('../../shared/retry')

describe('RetryManager', () => {
  it('returns result when fn succeeds first try', async () => {
    const r = new RetryManager({ maxRetries: 2, initialDelay: 1 })
    const v = await r.retry(async () => 7)
    expect(v).toBe(7)
  })

  it('retries on retryable error then succeeds', async () => {
    const r = new RetryManager({ maxRetries: 3, initialDelay: 1, maxDelay: 5 })
    let n = 0
    const err = new Error('boom')
    err.code = 'ECONNRESET'
    const v = await r.retry(async () => {
      n += 1
      if (n < 2) throw err
      return 'ok'
    })
    expect(v).toBe('ok')
    expect(n).toBe(2)
  })

  it('does not retry non-retryable errors', async () => {
    const r = new RetryManager({ maxRetries: 3, initialDelay: 1 })
    await expect(
      r.retry(async () => {
        throw new Error('validation failed')
      })
    ).rejects.toThrow('validation failed')
  })
})
