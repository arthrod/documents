import { Elysia } from 'elysia'
import { db } from '../db'

export const registerLogRoute = (app: Elysia) =>
  app.get('/api/log', async ({ set }) => {
    try {
      await db.$queryRaw`SELECT 1`
      console.log('Database connection test successful')
      return { status: 'Database connection successful' }
    } catch (error) {
      console.error('Database connection test failed:', error)
      set.status = 500
      return {
        status: 'Database connection failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })
