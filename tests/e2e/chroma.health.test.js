const Record = require('../../index')
const { runChroma } = require('./helpers/e2eEnv')

const describeChroma = runChroma() ? describe : describe.skip

describeChroma('e2e: ChromaDB', () => {
  it('connectChroma healthCheck', async () => {
    const chroma = Record.connectChroma({
      url: process.env.CHROMA_BASE_URL || 'http://127.0.0.1:8000',
      collection: `e2e_${Date.now()}`,
    })
    let last
    for (let i = 0; i < 15; i += 1) {
      last = await chroma.healthCheck()
      if (last.status === 'healthy') break
      await new Promise((r) => setTimeout(r, 2000))
    }
    expect(last.status).toBe('healthy')
  })
})
