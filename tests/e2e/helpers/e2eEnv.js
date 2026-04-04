/**
 * E2E gates: set E2E_ALL=1 (CI) or individual E2E_* flags for local runs.
 */
function e2eAll() {
  return process.env.E2E_ALL === '1'
}

function runPostgres() {
  return e2eAll() || process.env.E2E_POSTGRES === '1' || Boolean(process.env.E2E_POSTGRES_URL)
}

function runMysql() {
  return e2eAll() || process.env.E2E_MYSQL === '1'
}

function runMongodb() {
  return e2eAll() || process.env.E2E_MONGODB === '1'
}

function runRedis() {
  return e2eAll() || process.env.E2E_REDIS === '1'
}

function runNeo4j() {
  return e2eAll() || process.env.E2E_NEO4J === '1'
}

function runElasticsearch() {
  return e2eAll() || process.env.E2E_ELASTICSEARCH === '1'
}

function runChroma() {
  return e2eAll() || process.env.E2E_CHROMA === '1'
}

function uniqueSuffix() {
  return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`
}

function isHealthOk(h) {
  if (!h) return false
  if (h.healthy === true) return true
  if (h.status === 'healthy') return true
  return false
}

/**
 * TCP "open" is not enough for MySQL init, Neo4j boot, or ES cluster formation.
 */
async function waitForDbHealth(healthCheckAsync, { label = 'database', attempts = 40, delayMs = 2500 } = {}) {
  let last
  for (let i = 0; i < attempts; i += 1) {
    try {
      last = await healthCheckAsync()
      if (isHealthOk(last)) {
        return last
      }
    } catch (e) {
      last = { error: e.message }
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  const detail = last?.error || last?.status || JSON.stringify(last)
  let msg = `${label} not healthy after ~${attempts * delayMs}ms: ${detail}`
  if (e2eAll() || /ECONNREFUSED|not connect/i.test(String(detail))) {
    msg +=
      '\nTip: start Docker services (`docker compose up -d`), run `npm run wait-for-services`, then retry. ' +
      'Without all backends, use per-flag e2e (e.g. E2E_POSTGRES=1) instead of E2E_ALL=1.'
  }
  throw new Error(msg)
}

module.exports = {
  e2eAll,
  runPostgres,
  runMysql,
  runMongodb,
  runRedis,
  runNeo4j,
  runElasticsearch,
  runChroma,
  uniqueSuffix,
  waitForDbHealth,
}
