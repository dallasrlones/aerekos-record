/**
 * Geospatial Queries Manager
 * Provides location-based queries with PostGIS/MongoDB geospatial support
 */
class GeospatialManager {
  constructor(modelApi) {
    this.modelApi = modelApi
  }

  /**
   * Check if geospatial is supported
   */
  isSupported() {
    const backend = this.modelApi.__backend || 'unknown'
    return backend === 'psql' || backend === 'mongodb'
  }

  /**
   * Find records near a point (within radius)
   */
  async near(latitude, longitude, radiusMeters, options = {}) {
    const backend = this.modelApi.__backend || 'unknown'
    const field = options.field || 'location'

    switch (backend) {
      case 'psql':
        return this.nearPostgreSQL(latitude, longitude, radiusMeters, field, options)
      case 'mongodb':
        return this.nearMongoDB(latitude, longitude, radiusMeters, field, options)
      default:
        throw new Error(`Geospatial queries not supported for ${backend}`)
    }
  }

  /**
   * PostgreSQL PostGIS near query
   */
  async nearPostgreSQL(latitude, longitude, radiusMeters, field, options) {
    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    const limit = options.limit || 10
    const offset = options.offset || 0
    const orderBy = options.orderBy || 'distance'

    // Assume location is stored as POINT or (lat, lng) columns
    // For POINT: ST_Distance(location, ST_MakePoint(longitude, latitude))
    // For lat/lng columns: ST_Distance(ST_MakePoint(lng, lat), ST_MakePoint(longitude, latitude))
    
    const sql = `
      SELECT *,
        ST_Distance(
          ST_MakePoint(${field}_lng, ${field}_lat)::geography,
          ST_MakePoint($1, $2)::geography
        ) AS distance
      FROM ${tableName}
      WHERE ST_DWithin(
        ST_MakePoint(${field}_lng, ${field}_lat)::geography,
        ST_MakePoint($1, $2)::geography,
        $3
      )
      ORDER BY distance ${orderBy === 'distance' ? 'ASC' : 'DESC'}
      LIMIT $4 OFFSET $5
    `

    const result = await pool.query(sql, [longitude, latitude, radiusMeters, limit, offset])
    return result.rows.map(row => {
      const { distance, ...rest } = row
      return { ...rest, distance }
    })
  }

  /**
   * MongoDB geospatial near query
   */
  async nearMongoDB(latitude, longitude, radiusMeters, field, options) {
    const collectionName = this.modelApi.__collectionName
    const getCollection = this.modelApi.__adapterInstance?.getCollection

    if (!getCollection) {
      throw new Error('MongoDB collection access not available')
    }

    const collection = await getCollection(collectionName)
    const limit = options.limit || 10
    const offset = options.offset || 0

    // MongoDB $near query
    const query = {
      [field]: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude], // MongoDB uses [lng, lat]
          },
          $maxDistance: radiusMeters,
        },
      },
    }

    const results = await collection
      .find(query)
      .limit(limit)
      .skip(offset)
      .toArray()

    return results.map(doc => {
      const { _id, ...rest } = doc
      return { id: _id.toString(), ...rest }
    })
  }

  /**
   * Find records within a bounding box
   */
  async withinBounds(minLat, minLng, maxLat, maxLng, options = {}) {
    const backend = this.modelApi.__backend || 'unknown'
    const field = options.field || 'location'

    switch (backend) {
      case 'psql':
        return this.withinBoundsPostgreSQL(minLat, minLng, maxLat, maxLng, field, options)
      case 'mongodb':
        return this.withinBoundsMongoDB(minLat, minLng, maxLat, maxLng, field, options)
      default:
        throw new Error(`Geospatial queries not supported for ${backend}`)
    }
  }

  /**
   * PostgreSQL bounding box query
   */
  async withinBoundsPostgreSQL(minLat, minLng, maxLat, maxLng, field, options) {
    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE ${field}_lat BETWEEN $1 AND $2
        AND ${field}_lng BETWEEN $3 AND $4
    `

    const result = await pool.query(sql, [minLat, maxLat, minLng, maxLng])
    return result.rows
  }

  /**
   * MongoDB bounding box query
   */
  async withinBoundsMongoDB(minLat, minLng, maxLat, maxLng, field, options) {
    const collectionName = this.modelApi.__collectionName
    const getCollection = this.modelApi.__adapterInstance?.getCollection

    if (!getCollection) {
      throw new Error('MongoDB collection access not available')
    }

    const collection = await getCollection(collectionName)

    const query = {
      [field]: {
        $geoWithin: {
          $box: [
            [minLng, minLat], // Southwest corner
            [maxLng, maxLat], // Northeast corner
          ],
        },
      },
    }

    const results = await collection.find(query).toArray()
    return results.map(doc => {
      const { _id, ...rest } = doc
      return { id: _id.toString(), ...rest }
    })
  }

  /**
   * Find records within a polygon
   */
  async withinPolygon(coordinates, options = {}) {
    const backend = this.modelApi.__backend || 'unknown'
    const field = options.field || 'location'

    switch (backend) {
      case 'psql':
        return this.withinPolygonPostgreSQL(coordinates, field, options)
      case 'mongodb':
        return this.withinPolygonMongoDB(coordinates, field, options)
      default:
        throw new Error(`Geospatial queries not supported for ${backend}`)
    }
  }

  /**
   * PostgreSQL polygon query
   */
  async withinPolygonPostgreSQL(coordinates, field, options) {
    const tableName = this.modelApi.__tableName || this.modelApi.__collectionName
    const pool = this.modelApi.__adapterInstance?.pool || this.modelApi.__pool

    if (!pool) {
      throw new Error('PostgreSQL pool not available')
    }

    // Convert coordinates to PostGIS polygon format
    const polygonCoords = coordinates.map(([lng, lat]) => `${lng} ${lat}`).join(', ')
    const polygonWKT = `POLYGON((${polygonCoords}))`

    const sql = `
      SELECT *
      FROM ${tableName}
      WHERE ST_Within(
        ST_MakePoint(${field}_lng, ${field}_lat),
        ST_GeomFromText($1, 4326)
      )
    `

    const result = await pool.query(sql, [polygonWKT])
    return result.rows
  }

  /**
   * MongoDB polygon query
   */
  async withinPolygonMongoDB(coordinates, field, options) {
    const collectionName = this.modelApi.__collectionName
    const getCollection = this.modelApi.__adapterInstance?.getCollection

    if (!getCollection) {
      throw new Error('MongoDB collection access not available')
    }

    const collection = await getCollection(collectionName)

    const query = {
      [field]: {
        $geoWithin: {
          $geometry: {
            type: 'Polygon',
            coordinates: [coordinates], // MongoDB expects array of coordinate arrays
          },
        },
      },
    }

    const results = await collection.find(query).toArray()
    return results.map(doc => {
      const { _id, ...rest } = doc
      return { id: _id.toString(), ...rest }
    })
  }

  /**
   * Calculate distance between two points
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    // Haversine formula
    const R = 6371000 // Earth radius in meters
    const dLat = this.toRadians(lat2 - lat1)
    const dLng = this.toRadians(lng2 - lng1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  /**
   * Convert degrees to radians
   */
  toRadians(degrees) {
    return degrees * (Math.PI / 180)
  }
}

module.exports = GeospatialManager

