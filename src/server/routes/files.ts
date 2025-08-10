import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db'
import { authenticateUser } from '../auth'
import { Prisma } from '@prisma/client'
import { getS3Client } from '../../lib/s3'
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const querySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 10),
  type: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  search: z.string().optional()
}).transform(data => ({
  ...data,
  page: data.page || 1,
  limit: data.limit || 10,
  status: data.status as Prisma.FileWhereInput['status']
}))

const updateFileSchema = z.object({
  name: z.string().optional(),
  metadata: z.object({
    fileType: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
}).transform(data => ({
  ...data,
  status: data.status as any
}))

export const registerFileRoutes = (app: Elysia) => {
  app.get('/api/files', async ({ headers, query, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) {
        set.status = 401
        return { error: 'Authentication required' }
      }
      const token = authHeader.split(' ')[1]
      if (!token) {
        set.status = 401
        return { error: 'Invalid authentication format' }
      }
      const userId = await authenticateUser(token)

      const { page, limit, type, status, search } = querySchema.parse(query)

      const where: Prisma.FileWhereInput = {
        userId,
        ...(type && { type }),
        ...(status && { status }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { type: { contains: search, mode: 'insensitive' } }
          ]
        })
      }

      const skip = (page - 1) * limit
      const [files, total] = await Promise.all([
        db.file.findMany({
          where,
          skip,
          take: limit,
          orderBy: { uploadedAt: 'desc' },
          select: {
            id: true,
            name: true,
            type: true,
            size: true,
            url: true,
            key: true,
            status: true,
            uploadedAt: true,
            updatedAt: true,
            metadata: true
          }
        }),
        db.file.count({ where })
      ])

      const s3Client = getS3Client()
      const bucketName = process.env.AWS_BUCKET_NAME
      const filesWithUrls = await Promise.all(
        files.map(async (file) => {
          try {
            const command = new GetObjectCommand({
              Bucket: bucketName,
              Key: file.key,
              ResponseContentDisposition: 'inline'
            })
            const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 })
            return { ...file, url }
          } catch {
            return file
          }
        })
      )

      const totalPages = Math.ceil(total / limit)
      const hasMore = page < totalPages

      return {
        files: filesWithUrls,
        pagination: { total, page, totalPages, hasMore }
      }
    } catch (err) {
      console.error('[Files List] Unhandled error:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.get('/api/files/:id', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const fileId = params.id

      const file = await db.file.findFirst({ where: { id: fileId, userId } })
      if (!file) {
        set.status = 404
        return { error: 'File not found' }
      }
      try {
        const s3Client = getS3Client()
        const bucketName = process.env.AWS_BUCKET_NAME!
        const command = new GetObjectCommand({ Bucket: bucketName, Key: file.key, ResponseContentDisposition: 'inline' })
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 })
        return { ...file, url }
      } catch {
        return file
      }
    } catch (err) {
      console.error('Error handling file request:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.patch('/api/files/:id', async ({ headers, params, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const fileId = params.id

      const validatedInput = updateFileSchema.parse(body)
      const file = await db.file.findFirst({ where: { id: fileId, userId } })
      if (!file) {
        set.status = 404
        return { error: 'File not found' }
      }

      const currentMetadata = (file.metadata as any) || { fileType: file.type, description: '', version: 1 }
      const updatedFile = await db.file.update({
        where: { id: fileId },
        data: {
          ...(validatedInput.name && { name: validatedInput.name }),
          ...(validatedInput.status && { status: validatedInput.status }),
          ...(validatedInput.metadata && {
            metadata: {
              fileType: validatedInput.metadata.fileType ?? currentMetadata.fileType,
              description: validatedInput.metadata.description ?? currentMetadata.description,
              version: currentMetadata.version
            }
          })
        }
      })
      return updatedFile
    } catch (error) {
      console.error('Error updating file:', error)
      if (error instanceof z.ZodError) {
        set.status = 400
        return { error: 'Invalid request data', details: error.issues }
      }
      set.status = 500
      return { error: 'Failed to update file' }
    }
  })

  app.delete('/api/files/:id', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const fileId = params.id

      const file = await db.file.findFirst({ where: { id: fileId, userId } })
      if (!file) {
        set.status = 404
        return { error: 'File not found' }
      }

      const s3Client = getS3Client()
      const bucketName = process.env.AWS_BUCKET_NAME!
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: file.key }))
      } catch (e) {
        console.error('Error deleting file from S3:', e)
        set.status = 500
        return { error: 'Failed to delete file from storage' }
      }

      await db.file.delete({ where: { id: fileId } })
      set.status = 204
      return
    } catch (err) {
      console.error('Error handling delete request:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.post('/api/files/:id/complete', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Missing authorization header' } }
      const token = authHeader.split(' ')[1]
      if (!token) { set.status = 401; return { error: 'Invalid authorization format' } }
      const userId = await authenticateUser(token)
      if (!userId) { set.status = 401; return { error: 'Invalid token' } }

      const fileId = params.id
      const file = await db.file.findFirst({ where: { id: fileId, userId } })
      if (!file) {
        set.status = 404
        return { error: 'File not found', code: 'FILE_NOT_FOUND', message: 'The requested file does not exist' }
      }

      const updatedFile = await db.file.update({ where: { id: fileId }, data: { status: 'approved' } })
      return updatedFile
    } catch (error) {
      console.error('Error completing file upload:', error)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })
}
