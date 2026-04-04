# Aerekos Record Examples

This directory contains comprehensive examples demonstrating how to use Aerekos Record with different database types.

## Database-Specific Examples

### Neo4j (`neo4j/user.js`)
- User and Profile models with associations
- Neo4j-specific edge relationships
- Graph database patterns
- FOLLOWS relationships example

### MongoDB (`mongodb/user.js`)
- User and Profile models
- Change streams (real-time notifications)
- Full-text search
- Geospatial queries (with setup)
- Document store patterns

### PostgreSQL (`psql/user.js`)
- User and Profile models
- JSONB operations
- Full-text search with tsvector
- Geospatial queries with PostGIS
- Transactions
- Composite keys
- Advanced query builder

### Elasticsearch (`elasticsearch/user.js`)
- User and Profile models
- Full-text search (Elasticsearch specialty)
- Multi-term search
- Relevance scoring
- Search field configuration

### Redis (`redis/user.js`)
- User and Profile models
- TTL management
- Key-value store patterns
- Expiration examples

## Advanced Features (`advanced-features.js`)

Comprehensive examples of all advanced features:

- **Migrations** - Schema versioning and migrations
- **Seeding** - Database seeding utilities
- **Caching** - Redis and in-memory caching
- **Observability** - Query logging and metrics
- **Retry & Circuit Breaker** - Resilience patterns
- **Polymorphic Associations** - Polymorphic relationships
- **Composite Keys** - Multi-field primary keys
- **Sharding** - Multi-database and sharding

## Running Examples

Each example file can be run independently:

```bash
# Neo4j example
node EXAMPLES/neo4j/user.js

# MongoDB example
node EXAMPLES/mongodb/user.js

# PostgreSQL example
node EXAMPLES/psql/user.js

# Elasticsearch example
node EXAMPLES/elasticsearch/user.js

# Redis example
node EXAMPLES/redis/user.js

# Advanced features
node EXAMPLES/advanced-features.js
```

## Environment Variables

Set these environment variables before running examples:

```bash
# Neo4j
export NEO4J_URI="neo4j://localhost:7687"
export NEO4J_USER="neo4j"
export NEO4J_PASSWORD="password"

# MongoDB
export MONGODB_URI="mongodb://localhost:27017"
export MONGODB_DATABASE="myapp"

# PostgreSQL
export PG_HOST="localhost"
export PG_PORT="5432"
export PG_DATABASE="myapp"
export PG_USER="postgres"
export PG_PASSWORD="password"

# Elasticsearch
export ES_NODE="http://localhost:9200"

# Redis
export REDIS_HOST="localhost"
export REDIS_PORT="6379"
export REDIS_PASSWORD=""
```

## Common Patterns

All examples demonstrate:

1. **Model Definition** - Properties, types, settings
2. **Associations** - hasOne, hasMany, belongsTo
3. **Callbacks** - before_create, after_save, etc.
4. **CRUD Operations** - create, find, update, delete
5. **Query Builder** - Fluent query API
6. **Batch Operations** - Bulk create/update
7. **Streaming** - Process large result sets
8. **Health Checks** - Database connectivity

## Features Demonstrated

- ✅ Model definition with types
- ✅ Associations (hasOne, hasMany, belongsTo)
- ✅ Rails-style callbacks
- ✅ Query builder
- ✅ Batch operations
- ✅ Streaming
- ✅ Full-text search
- ✅ Geospatial queries (PostgreSQL/MongoDB)
- ✅ Change streams (MongoDB)
- ✅ TTL management (Redis)
- ✅ Edge relationships (Neo4j)
- ✅ JSON/JSONB operations (PostgreSQL)
- ✅ Composite keys
- ✅ Polymorphic associations
- ✅ Migrations
- ✅ Seeding
- ✅ Caching
- ✅ Observability
- ✅ Retry & Circuit Breaker
- ✅ Sharding

## Notes

- Examples use environment variables for configuration
- All examples include error handling
- Examples can be run independently or together
- Each example demonstrates database-specific features
- Advanced features example shows cross-database patterns

