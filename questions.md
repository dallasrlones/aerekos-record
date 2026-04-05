# Project decisions (reference)

Architectural defaults for **aerekos-record**. Override only when you have a deliberate reason.

---

## Canonical release metadata

- **npm name:** `aerekos-record` (see `package.json`).
- **GitHub:** `https://github.com/dallasrlones/aerekos-record` — `repository`, `bugs`, and `homepage` in `package.json` should match the live remote.
- **License:** `LICENSE` — `Copyright (c) 2026 Aerekos`. Use your legal entity name there if it differs.

---

## Repository layout

- **Standalone package repo at root** is the default: `npm ci`, `docker compose`, and tests assume the clone root is this package. In a monorepo, run those commands from this package directory (or wire your own automation).

## Peer dependencies and lazy loading

- **Lazy-loaded adapters** (`index.js`) so `require('aerekos-record')` does not pull every driver. Consumers install only what they use; CJS has no tree-shaking, so lazy `require` is the practical lever.
- **`bcryptjs` + `axios` as direct dependencies:** used by shared paths (encryption, Chroma HTTP, Ollama provider).
- **Database clients** stay optional peers with `peerDependenciesMeta.optional: true`.

## Node version

- **`engines.node: ">=18"`** — CI runs unit tests on Node 18 / 20 / 22.

## Versioning

- **`0.1.0`** until the public `connect` / `model` API is semver-stable; bump to **`1.0.0`** when you are ready to commit to semver for that surface.

## Additional SQL backends

- **MySQL / MariaDB:** `mysql` / `mariadb` keys, `mysql2`, InnoDB, utf8mb4.
- **CockroachDB, YugabyteDB, TimescaleDB:** use **`psql`** against their Postgres wire protocol unless a dialect bug forces a fork.
- **SQL Server / Oracle:** not in scope without a dedicated adapter owner.
- **DynamoDB / Firestore:** different consistency and query models; a separate package or scoped API is healthier than pretending parity with this ORM.

## Multi-DB testing (local)

- **Default:** `npm test` (unit + SQLite e2e).
- **Full stack:** `docker compose up -d && npm run test:e2e:docker` (`wait-for-services` + `E2E_ALL=1` Jest).

## Elasticsearch / Neo4j / Chroma in Docker

- **Elasticsearch:** single-node dev/CI pattern; production needs a real cluster and auth.
- **Neo4j:** compose caps heap; tests use Bolt to `127.0.0.1:7687`.
- **Chroma:** heartbeat tries v1 then v2; TCP readiness ≠ HTTP ready — tests retry.

## Security & community (when public)

- Add **`SECURITY.md`** (contact or GitHub Security Advisories).
- Add **`CODE_OF_CONDUCT.md`** (e.g. Contributor Covenant) if you want external contributors.

## `aerekos-storage` and attachments

- **Shipped in-repo** under the same license so `npm pack` and attachment examples work. Splitting to a separate package is optional later.
