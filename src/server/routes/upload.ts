import { Elysia } from 'elysia'
import { randomUUID } from 'crypto'
import type { FileStatus } from '@prisma/client'
import { createPresignedUploadUrl } from '../../lib/s3'
import { authenticateUser } from '../auth'
import { db } from '../db'

export const registerUploadRoute = (app: Elysia) =>
  app.post('/api/upload', async ({ body, headers, set }) => {
    try {
      const authHeader = headers['authorization']
      if (!authHeader) {
        set.status = 401
        return { error: 'Missing authorization header' }
      }

      const token = (authHeader as string).split(' ')[1]
      if (!token) {
        set.status = 401
        return { error: 'Invalid authorization format' }
      }

      const userId = await authenticateUser(token)
      if (!userId) {
        set.status = 401
        return { error: 'Invalid token' }
      }

      const { fileName, fileType, fileSize } = body as any
      if (!fileName || !fileType || !fileSize) {
        set.status = 400
        return { error: 'Missing required fields' }
      }

      const fileId = randomUUID()
      const key = `${userId}/${fileId}/${fileName}`

      try {
        const presignedData = await createPresignedUploadUrl(key, fileType)

        const file = await db.file.create({
          data: {
            id: fileId,
            userId,
            name: fileName,
            type: fileType,
            size: fileSize,
            key,
            url: `https://${presignedData.bucket}.s3.${presignedData.region}.amazonaws.com/${key}`,
            status: 'pending' as FileStatus,
            metadata: {
              fileType,
              description: '',
              version: 1
            }
          }
        })

        return {
          fileId: file.id,
          uploadUrl: presignedData.url,
          fields: presignedData.fields
        }
      } catch (error) {
        console.error('Error with S3 or database:', error)
        set.status = 500
        return { error: 'Failed to prepare upload' }
      }
    } catch (error) {
      console.error('Error handling upload request:', error)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })
