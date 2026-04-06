/**
 * better-sqlite3 only accepts a narrow set of JS types as bound parameters.
 * Boolean is not allowed — INTEGER columns need 0 or 1.
 */
function normalizeSqliteBind(v) {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v)) return v.map(normalizeSqliteBind)
  return v
}

/** After TYPE_COERCERS.boolean (true/false), convert booleans to 0/1 for INSERT/UPDATE. */
function coerceBooleansForSqliteStorage(attrs, properties) {
  if (!attrs || !properties) return attrs
  const out = { ...attrs }
  for (const [key, type] of Object.entries(properties)) {
    if (type !== 'boolean' || !(key in out)) continue
    const val = out[key]
    if (val === null || val === undefined) continue
    if (typeof val === 'boolean') out[key] = val ? 1 : 0
  }
  return out
}

module.exports = { normalizeSqliteBind, coerceBooleansForSqliteStorage }
