import { Elysia } from 'elysia'
import { db } from '../db'

export const registerHealthcheck = (app: Elysia) =>
  app.get('/api/healthcheck', async ({ set }) => {
    try {
      await db.$queryRaw`SELECT 1`
      return { status: 'healthy' }
    } catch (error) {
      console.error('Healthcheck failed:', error)
      set.status = 500
      return { status: 'unhealthy', error: 'Database connection failed' }
    }
  })
