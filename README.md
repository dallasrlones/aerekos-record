# Aerekos Record

Universal **Active Record–style** models for Node.js: define a schema once and use the same CRUD patterns across **PostgreSQL, MySQL/MariaDB, SQLite, MongoDB, Redis, Neo4j, Elasticsearch**, plus **ChromaDB** for vectors. Adapters are **lazy-loaded** so you only install the drivers you use.

---

## Supported backends

| Backend | `Record.connect(...)` keys | Peer package |
|--------|----------------------------|--------------|
| PostgreSQL | `psql`, `postgres`, `postgresql` | `pg` |
| MySQL / MariaDB | `mysql`, `mariadb` | `mysql2` |
| SQLite | `sqlite` | `better-sqlite3` |
| MongoDB | `mongodb` | `mongodb` |
| Redis | `redis` | `redis` |
| Neo4j | `neo4j` | `neo4j-driver` |
| Elasticsearch | `elasticsearch`, `es` | `@elastic/elasticsearch` |
| Chroma (vectors) | `Record.connectChroma({ ... })` | *(HTTP / `axios` — see Chroma section)* |

---

## Installation

```bash
npm install aerekos-record
```

Install **only** the database clients you need (they are optional `peerDependencies`):

```bash
# Examples — pick what you use
npm install pg
npm install mysql2
npm install better-sqlite3
npm install mongodb
npm install redis
npm install neo4j-driver
npm install @elastic/elasticsearch
```

---

## Mental model

1. **`Record.connect(type, settings)`** returns a **database handle** with `.model()`, `.healthCheck()`, `.getPoolStats()`, `.close()`, and (depending on adapter) `.pool` / `.driver` / raw clients.
2. **`db.model(name, properties, settings?)`** registers a model. Table/collection/index names are derived from the model name (e.g. `User` → `users`).
3. **Timestamps** default to **on** (`timestamps: true`). Stored fields are **`created_at`**, **`updated_at`**, and (with soft delete) **`deleted_at`** — **snake_case** on instances.
4. Every model is **enhanced** with helpers (see [Enhanced model API](#enhanced-model-api)); some helpers are **backend-specific** (e.g. Neo4j edges, Mongo change streams).

---

## Quick start (SQLite file)

```javascript
const Record = require('aerekos-record')

const db = Record.connect('sqlite', {
  database: './app.sqlite',
  verbose: (sql) => process.env.DEBUG_SQL && console.log(sql), // optional logger fn
})

const User = db.model(
  'User',
  {
    name: 'string',
    email: 'string',
    password: 'encrypted',
  },
  {
    required: ['email', 'password'],
    unique: ['email'],
    timestamps: true,
  }
)

const user = await User.create({
  name: 'Ada',
  email: 'ada@example.com',
  password: 'secret',
})

console.log(user.id, user.email, user.created_at)
await db.close()
```

---

## Examples by database

Each block is a **minimal but complete** pattern: connect → define model → create → read → update → delete → cleanup.

### PostgreSQL

```javascript
const Record = require('aerekos-record')

const db = Record.connect('psql', {
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'myapp',
  max: 10,
  idleTimeoutMillis: 30000,
})

// Or: Record.connect('postgres', { connectionString: process.env.DATABASE_URL })

const health = await db.healthCheck()
if (!health.healthy) throw new Error(health.error)

const Article = db.model(
  'Article',
  { title: 'string', score: 'number' },
  { required: ['title'], indexes: ['title'], timestamps: true }
)

const row = await Article.create({ title: 'Hello', score: 1 })
const one = await Article.find(row.id)
const byTitle = await Article.findBy({ title: 'Hello' })
const many = await Article.findAll({
  where: { score: { gte: 0 } },
  order: 'created_at DESC',
  limit: 10,
})
const updated = await Article.update(row.id, { score: 99 })
await Article.delete(row.id, { hardDelete: true })

await db.close()
```

### MySQL / MariaDB

```javascript
const Record = require('aerekos-record')

const db = Record.connect('mysql', {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'myapp',
})

// Equivalent: Record.connect('mariadb', { ...same options })

const Item = db.model('Item', { label: 'string', n: 'number' }, { required: ['label'], timestamps: true })

const row = await Item.create({ label: 'a', n: 1 })
const found = await Item.findBy({ label: 'a' })
const updated = await Item.update(row.id, { n: 42 })
await Item.delete(row.id, { hardDelete: true })

await db.close()
```

**Note:** The adapter normalizes ISO timestamps into `DATETIME(3)` and coerces numeric columns on read (MySQL often returns decimals as strings).

### SQLite

```javascript
const Record = require('aerekos-record')

const db = Record.connect('sqlite', {
  database: './dev.sqlite',
  timeout: 5000,
})

const Tag = db.model('Tag', { name: 'string' }, { unique: ['name'], timestamps: true })

const t = await Tag.create({ name: 'docs' })
const all = await Tag.findAll({ where: { name: { contains: 'doc' } } })
await Tag.update(t.id, { name: 'documentation' })
// SQLite adapter also exposes deleteBy(where) on the model
await Tag.deleteBy({ name: 'documentation' })

await db.close()
```

### MongoDB

```javascript
const Record = require('aerekos-record')

const db = Record.connect('mongodb', {
  uri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  database: process.env.MONGO_DB || 'myapp',
  options: {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 30000,
  },
})

const Doc = db.model('Doc', { title: 'string', views: 'number' }, { required: ['title'], timestamps: true })

const row = await Doc.create({ title: 'Hi', views: 0 })
const found = await Doc.findBy({ title: 'Hi' })
await Doc.update(row.id, { views: 1 })
await Doc.delete(row.id, { hardDelete: true })

await db.close()
```

### Redis

```javascript
const Record = require('aerekos-record')

const db = Record.connect('redis', {
  socket: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
  password: process.env.REDIS_PASSWORD || undefined,
})

const Session = db.model(
  'Session',
  { token: 'string', user_id: 'string' },
  { required: ['token'], timestamps: true }
)

// Optional TTL (seconds) on create / update
const s = await Session.create({ token: 'abc', user_id: 'u1' }, { ttl: 3600 })
await Session.setTTL(s.id, 7200)
const ttl = await Session.getTTL(s.id)

await Session.update(s.id, { user_id: 'u2' }, { ttl: 1800 })
await Session.delete(s.id, { hardDelete: true })

await db.close()
```

### Neo4j

```javascript
const Record = require('aerekos-record')

const db = Record.connect('neo4j', {
  uri: process.env.NEO4J_URI || 'neo4j://127.0.0.1:7687',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
  maxConnectionPoolSize: 50,
})

const Person = db.model('Person', { name: 'string' }, { required: ['name'], timestamps: true })
const Post = db.model('Post', { title: 'string', person_id: 'string' }, { belongsTo: 'Person' })

const alice = await Person.create({ name: 'Alice' })
const post = await Post.create({ title: 'Graphs', person_id: alice.id })

// Graph relationships (Neo4j-specific)
await Person.edges.createEdge({
  fromId: alice.id,
  toId: post.id,
  type: 'WROTE',
  toModel: 'Post',
  direction: 'out',
})

// Delete in dependency order (or use your own graph cleanup rules)
await Post.delete(post.id, { hardDelete: true })
await Person.delete(alice.id, { hardDelete: true })

await db.close()
```

### Elasticsearch

```javascript
const Record = require('aerekos-record')

const db = Record.connect('elasticsearch', {
  node: process.env.ES_URL || 'http://127.0.0.1:9200',
  auth:
    process.env.ES_USER && process.env.ES_PASSWORD
      ? { username: process.env.ES_USER, password: process.env.ES_PASSWORD }
      : undefined,
  requestTimeout: 60000,
  sniffOnStart: false, // often better for single-node local / Docker
})

const Log = db.model('Log', { message: 'string', level: 'string' }, { required: ['message'], timestamps: true })

const row = await Log.create({ message: 'boot', level: 'info' })
const got = await Log.find(row.id)
await Log.update(row.id, { level: 'warn' })
await Log.delete(row.id, { hardDelete: true })

const ok = await db.healthCheck()
// ok.status is e.g. 'up' when the HTTP API responds

await db.close()
```

### ChromaDB (vector store)

Chroma is exposed as a **separate** adapter for embeddings / RAG pipelines (often alongside Postgres or SQLite).

```javascript
const Record = require('aerekos-record')

const chroma = Record.connectChroma({
  url: process.env.CHROMA_BASE_URL || 'http://127.0.0.1:8000',
  collection: 'my_docs',
  // logQueries: true, // or AEREKOS_DEBUG_CHROMA=1 for verbose HTTP logs
})

const health = await chroma.healthCheck()
console.log(health) // { status: 'healthy', ... }

// Use chroma + Record.connect(...) model embeddings — see "Embeddings" below
```

---

## Model definition

### Property types

| Type | Behavior |
|------|----------|
| `string` | Coerced with `String()` |
| `number` | Coerced with `Number()` |
| `boolean` | Coerced with `Boolean()` |
| `datetime` | ISO strings via `Date` |
| `encrypted` | Bcrypt hash on write; **omitted** from normal reads |

```javascript
const Product = db.model(
  'Product',
  {
    sku: 'string',
    price: 'number',
    active: 'boolean',
    released_at: 'datetime',
    internal_note: 'encrypted',
  },
  { required: ['sku'], timestamps: true }
)
```

### Common settings

```javascript
db.model(
  'User',
  { email: 'string' },
  {
    required: ['email'],
    unique: ['email'],
    indexes: ['email'],
    timestamps: true,      // default true → created_at / updated_at
    softDelete: true,      // sets deleted_at instead of removing row/node/doc
    hasMany: ['Order'],
    hasOne: ['Profile'],
    belongsTo: 'Organization',
    callbacks: {
      before_create: async (attrs) => {
        attrs.email = String(attrs.email).toLowerCase()
      },
    },
  }
)
```

---

## CRUD & queries (shared API)

Typical methods on every model:

- **`create(attrs, options?)`** — Redis: `options.ttl` (seconds).
- **`find(id, options?)`** — `withDeleted` when `softDelete` is enabled.
- **`findBy(where, options?)`** / **`findOneBy`** (alias).
- **`findAll({ where, order, limit, offset, withDeleted, include, select })`**
- **`count(where, options?)`**
- **`update(id, changes, options?)`** — Redis: `options.ttl`.
- **`updateBy(where, changes, options?)`**
- **`updateOneBy(where, changes, options?)`**
- **`delete(id, { hardDelete })`**

### Where operators (where supported by the adapter)

```javascript
// Equality
await Model.findAll({ where: { status: 'active' } })

// IN list
await Model.findAll({ where: { status: ['a', 'b'] } })

// Ranges (gte / lte / $gt / $lt)
await Model.findAll({ where: { score: { gte: 0, lte: 100 } } })

// Substring / contains (SQL LIKE, Mongo regex, etc.)
await Model.findAll({ where: { title: { contains: 'report' } } })
```

**Ordering:** SQL adapters accept SQL fragments, e.g. `order: 'created_at DESC'` or `order: ['created_at DESC', 'id ASC']`. Graph/document/search backends may differ—inspect adapter behavior for complex sorts.

### Bulk delete by query

**SQLite** models expose **`deleteBy(where)`**. Other adapters currently rely on **`delete(id)`** or application-level queries.

---

## Associations

Foreign keys use the **`{parent}_id`** convention (e.g. `user_id` for `User`).

```javascript
const User = db.model('User', { name: 'string' }, { hasMany: ['Task'] })
const Task = db.model('Task', { title: 'string', user_id: 'string' }, { belongsTo: 'User' })

const user = await User.create({ name: 'Bob' })
await user.tasks.create({ title: 'Ship v1' })
const tasks = await user.tasks.findAll()
const task = await Task.findBy({ title: 'Ship v1' })
const parent = await task.parent()
```

### Eager loading (`include`)

```javascript
const users = await User.findAll({
  include: ['Task'],
})

const scoped = await User.findAll({
  include: [{ model: 'Task', where: { done: false }, as: 'openTasks' }],
})
```

---

## Callbacks (Rails-style)

You can register callbacks on the model **or** pass a `callbacks` object in settings. Supported hooks include:

`before_validation`, `after_validation`, `before_save`, `after_save`, `around_save`,  
`before_create` / `after_create` / `around_create`,  
`before_update` / `after_update` / `around_update`,  
`before_destroy` / `after_destroy` / `around_destroy`,  
plus validation variants (`*_on_create`, `*_on_update`).

```javascript
const User = db.model('User', { email: 'string' }, { timestamps: true })

User.before_create(async (attrs) => {
  attrs.email = attrs.email.trim().toLowerCase()
})

const user = await User.create({ email: '  YOU@EXAMPLE.COM  ' })
```

---

## Database-specific features

### Neo4j — edges API

Attached as **`Model.edges`** (see Neo4j example): `createEdge`, `findByEdge`, `findByEdges`, `updateEdgeBy`, `deleteEdge`, etc.

### Redis — TTL

- **`create(attrs, { ttl: seconds })`**
- **`update(id, changes, { ttl: seconds })`**
- **`Model.setTTL(id, seconds)`** / **`Model.getTTL(id)`**

### MySQL — timestamps & numbers

Writes map ISO times to **`DATETIME(3)`**. Reads coerce declared **`number`** fields so ORM values match other SQL drivers.

### Elasticsearch — health check

`healthCheck()` uses a lightweight HTTP check and reports **`status: 'up'`** when the cluster responds (not necessarily full cluster “green”).

---

## Embeddings (Chroma + providers)

When a model defines **`settings.embeddings`**, the **embedding enhancer** can auto-embed fields and query similar records. You need:

- A normal `Record.connect(...)` database for rows.
- **`Record.connectChroma({ url, collection, ... })`** passed as `chromaAdapter`.
- A provider (`ollama`, `openai`, or a registered custom provider).

```javascript
const Record = require('aerekos-record')

const db = Record.connect('psql', { host: 'localhost', database: 'myapp' })
const chroma = Record.connectChroma({ url: 'http://localhost:8000', collection: 'notes' })

const Note = db.model(
  'Note',
  { body: 'string', owner_id: 'string' },
  {
    timestamps: true,
    embeddings: {
      fields: ['body'],
      provider: 'ollama',
      providerConfig: {
        url: 'http://localhost:11434',
        model: 'nomic-embed-text',
      },
      chromaAdapter: chroma,
      metadataFields: ['owner_id'],
    },
  }
)

// After create/update, vectors can be stored in Chroma; similarity search:
// await Note.findSimilar('query text', { limit: 5, filters: { owner_id: '...' } })
```

Use **`Record.registerEmbeddingProvider(name, ProviderClass)`** for custom embedders (see `shared/embeddings/providers`).

---

## Enhanced model API

`shared/modelEnhancer` attaches helpers to **every** model (capability varies by backend):

| Namespace | Purpose |
|-----------|---------|
| **`Model.query()`** | Fluent `QueryBuilder` (`where`, `orderBy`, `limit`, `findAll`, …) |
| **`Model.batch`** | Bulk helpers (`bulkCreate`, `bulkUpdate`, …) |
| **`Model.stream`** | Chunked / streaming reads |
| **`Model.search`** | Full-text style helpers (strongest on Elasticsearch) |
| **`Model.json`** | JSON path style helpers where supported |
| **`Model.changes`** | **MongoDB only** — change streams |
| **`Model.geo`** | **PostgreSQL / MongoDB** — geospatial helpers |
| **`Model.compositeKeys`** | Composite key helpers |

Explore implementations under `shared/*.js` for exact method lists.

---

## Package-level utilities

```javascript
const Record = require('aerekos-record')

// Sharding / multi-db routing
const multi = Record.createMultiDatabase()
multi.addInstance('primary', Record.connect('psql', { host: 'db1' }))
const User = multi.model('User', { name: 'string' })

// Migrations, indexing, seeds
const migrations = Record.createMigrations(db, { migrationsPath: './migrations' })
const indexes = Record.createIndexManager(db)
const seeding = Record.createSeeding(db, { seedsPath: './seeds' })

// Resilience helpers (used standalone or to wrap calls)
const retry = Record.createRetry({ maxRetries: 5, initialDelay: 500 })
const breaker = Record.createCircuitBreaker({ failureThreshold: 5, resetTimeout: 60_000 })

// Caching (optional Redis cache connection)
const cacheConn = Record.connect('redis', { socket: { host: '127.0.0.1' } })
const caching = Record.createCaching(db, cacheConn)

// Observability hooks
const obs = Record.createObservability({ logQueries: true, slowQueryThreshold: 500 })
```

Exports also include **`MemoryCache`**, **`QueryBuilder`**, manager classes, **`createEmbeddingProvider`**, **`registerEmbeddingProvider`**, and **`Record.adapters`** for advanced use.

---

## Health, stats, shutdown

```javascript
const db = Record.connect('psql', { /* ... */ })

const health = await db.healthCheck()
const stats = db.getPoolStats()

process.on('SIGINT', async () => {
  await db.close()
  process.exit(0)
})
```

---

## Testing this package

```bash
npm ci
npm test                 # unit tests + SQLite e2e (always on)
```

**Optional e2e** (real databases): copy `.env.example` to `.env`, start Docker services, then:

```bash
docker compose up -d
npm run test:e2e:docker  # wait-for-services + test:e2e:ci (same as CI-style full e2e)
```

Or run the two steps yourself: `npm run wait-for-services` then `npm run test:e2e:ci` (`E2E_ALL=1`).

Opt in per backend when you do not want every service, e.g. `E2E_POSTGRES=1`, `E2E_MYSQL=1`, `E2E_NEO4J=1` (see `.env.example`).

---

## CI

GitHub Actions runs unit tests on Node 18 / 20 / 22 and a job that brings up **docker compose** and runs **`test:e2e:ci`**.

---

## More runnable samples

The repo includes **`EXAMPLES/`** with per-backend sketches and advanced topics:

- `EXAMPLES/psql/user.js`, `EXAMPLES/mongodb/user.js`, `EXAMPLES/redis/user.js`, `EXAMPLES/neo4j/user.js`, `EXAMPLES/elasticsearch/user.js`, `EXAMPLES/sqlite/user.js`
- `EXAMPLES/embeddings-example.js`, `EXAMPLES/attachments-example.js`, `EXAMPLES/advanced-features.js`

See **`EXAMPLES/README.md`** for how to run them.

---

## License

MIT
