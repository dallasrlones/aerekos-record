const CircuitBreaker = require('../../shared/circuitBreaker')

describe('CircuitBreaker', () => {
  it('executes successful fn in closed state', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 1000 })
    const out = await cb.execute(async () => 42)
    expect(out).toBe(42)
    expect(cb.isClosed()).toBe(true)
  })

  it('opens after repeated failures and can use fallback', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeout: 5000,
      monitoringWindow: 60000,
    })
    const fail = async () => {
      throw new Error('down')
    }
    await expect(cb.execute(fail)).rejects.toThrow('down')
    await expect(cb.execute(fail)).rejects.toThrow('down')
    expect(cb.isOpen()).toBe(true)

    const fb = await cb.execute(fail, () => 'fallback')
    expect(fb).toBe('fallback')
  })
})
