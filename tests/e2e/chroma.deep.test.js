const Record = require('../../index')
const { runChroma, uniqueSuffix } = require('./helpers/e2eEnv')

const describeChroma = runChroma() ? describe : describe.skip

describeChroma('e2e: ChromaDB (deep contract)', () => {
  it('ensureCollection, addEmbedding, querySimilar, delete paths', async () => {
    const suf = uniqueSuffix()
    const chroma = Record.connectChroma({
      url: process.env.CHROMA_BASE_URL || 'http://127.0.0.1:8000',
      collection: `e2e_deep_${suf}`,
    })

    let last
    for (let i = 0; i < 15; i += 1) {
      last = await chroma.healthCheck()
      if (last.status === 'healthy') break
      await new Promise((r) => setTimeout(r, 2000))
    }
    expect(last.status).toBe('healthy')

    const dim = 1024
    const emb = Array.from({ length: dim }, (_, i) => (i % 7 === 0 ? 0.02 : -0.01))

    await chroma.ensureCollection(chroma.__defaultCollection)
    const id = `vec-${suf}`
    await chroma.addEmbedding(
      id,
      emb,
      { userID: 'u1', text: 'contract test', recordId: `rec-${suf}` },
      chroma.__defaultCollection
    )

    const hits = await chroma.querySimilar(emb, 5, {}, chroma.__defaultCollection)
    expect(Array.isArray(hits)).toBe(true)

    await chroma.deleteByFilters({ recordId: `rec-${suf}` }, chroma.__defaultCollection)
    await chroma.deleteByIds([id], chroma.__defaultCollection)
  })
})
