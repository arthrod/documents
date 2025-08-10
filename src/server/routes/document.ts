import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db'
import { authenticateUser } from '../auth'
import { Prisma } from '@prisma/client'

// Schemas reused from Next routes
const plateTextSchema: z.ZodType<any> = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional()
}).passthrough()

const plateElementSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.string(),
    children: z.array(z.union([plateElementSchema, plateTextSchema]))
  }).passthrough()
)

const plateDocumentSchema: z.ZodType<any> = z.object({
  type: z.literal('doc'),
  content: z.array(plateElementSchema)
})

const documentInputSchema = z.object({
  title: z.string(),
  icon: z.union([
    z.string(),
    z.string().url(),
    z.null()
  ]).nullable().optional(),
  coverImage: z.union([
    z.string().regex(/^linear-gradient\(.*\)$/),
    z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    z.string().url(),
    z.null()
  ]).nullable().optional(),
  content: plateDocumentSchema,
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 })
})

const updateDocumentSchema = z.object({
  title: z.string().optional(),
  icon: z.union([
    z.string(),
    z.string().url(),
    z.null()
  ]).nullable().optional(),
  coverImage: z.union([
    z.string().regex(/^linear-gradient\(.*\)$/),
    z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    z.string().url(),
    z.null()
  ]).nullable().optional(),
  content: plateDocumentSchema.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional()
})

const collaboratorSchema = z.object({ userId: z.string() })

const createVersionSchema = z.object({ content: plateDocumentSchema })

export const registerDocumentRoutes = (app: Elysia) => {
  // List documents
  app.get('/api/document', async ({ headers, query, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)

      const parsed = z.object({
        limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 10),
        cursor: z.string().optional(),
        orderBy: z.enum(['updatedAt', 'createdAt', 'title']).optional().default('updatedAt'),
        order: z.enum(['asc', 'desc']).optional().default('desc')
      }).parse(query)

      const documents = await db.document.findMany({
        where: { users: { some: { id: userId } } },
        take: parsed.limit + 1,
        ...(parsed.cursor ? { skip: 1, cursor: { id: parsed.cursor } } : {}),
        orderBy: { [parsed.orderBy]: parsed.order },
        include: {
          users: { select: { id: true, name: true } },
          versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, createdAt: true } }
        }
      })

      const hasMore = documents.length > parsed.limit
      const items = hasMore ? documents.slice(0, -1) : documents
      const totalCount = await db.document.count({ where: { users: { some: { id: userId } } } })
      const nextCursor = hasMore ? items[items.length - 1].id : null

      return {
        items,
        pagination: { totalCount, pageSize: parsed.limit, hasMore, nextCursor }
      }
    } catch (err) {
      console.error('[Documents List] Unhandled error:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  // Create document
  app.post('/api/document/create', async ({ headers, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)

      const validated = documentInputSchema.parse(body)

      const result = await db.$transaction(async (tx) => {
        const doc = await tx.document.create({
          data: {
            title: validated.title,
            icon: validated.icon,
            coverImage: validated.coverImage,
            content: validated.content as Prisma.InputJsonValue,
            position: validated.position as Prisma.InputJsonValue,
            users: { connect: { id: userId } },
            versions: {
              create: {
                content: validated.content as Prisma.InputJsonValue,
                user: { connect: { id: userId } }
              }
            }
          },
          include: {
            users: { select: { id: true, name: true } },
            versions: { select: { id: true, createdAt: true, userId: true } }
          }
        })
        return doc
      })

      set.status = 201
      return result
    } catch (err) {
      console.error('[Document Create] error:', err)
      if (err instanceof z.ZodError) {
        set.status = 400
        return { error: 'Invalid document format', details: err.issues }
      }
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  // Document by id operations
  app.get('/api/document/:id', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({
        where: { id: documentId, users: { some: { id: userId } } },
        include: {
          users: { select: { id: true, name: true } },
          versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, createdAt: true } }
        }
      })
      if (!document) { set.status = 404; return { error: 'Document not found' } }
      return document
    } catch (err) {
      console.error('Error fetching document:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.patch('/api/document/:id', async ({ headers, params, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const validated = updateDocumentSchema.parse(body)

      const doc = await db.document.findFirst({
        where: { id: documentId, users: { some: { id: userId } } }
      })
      if (!doc) { set.status = 404; return { error: 'Document not found' } }

      const updated = await db.document.update({
        where: { id: documentId },
        data: {
          ...(validated.title && { title: validated.title }),
          ...(validated.icon !== undefined && { icon: validated.icon }),
          ...(validated.coverImage !== undefined && { coverImage: validated.coverImage }),
          ...(validated.position && { position: validated.position as Prisma.InputJsonValue }),
          ...(validated.content && { content: validated.content as Prisma.InputJsonValue })
        }
      })
      return updated
    } catch (err) {
      console.error('Error updating document:', err)
      if (err instanceof z.ZodError) {
        set.status = 400
        return { error: 'Invalid input', details: err.issues }
      }
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.delete('/api/document/:id', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({
        where: { id: documentId, users: { some: { id: userId } } },
        include: { users: true, versions: { select: { id: true } } }
      })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      await db.$transaction([
        db.document.update({
          where: { id: documentId },
          data: { users: { disconnect: document.users.map(u => ({ id: u.id })) } }
        }),
        db.version.deleteMany({ where: { documentId } }),
        db.document.delete({ where: { id: documentId } })
      ])

      set.status = 204
      return
    } catch (err) {
      console.error('Error deleting document:', err)
      set.status = 500
      return { error: 'Failed to delete document' }
    }
  })

  // Collaborators
  app.get('/api/document/:id/collaborators', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const collaborators = await db.user.findMany({
        where: { documents: { some: { id: documentId } } },
        select: { id: true, name: true }
      })
      return collaborators
    } catch (err) {
      console.error('Error handling collaborators:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.post('/api/document/:id/collaborators', async ({ headers, params, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const { userId: collaboratorId } = collaboratorSchema.parse(body)
      const user = await db.user.findUnique({ where: { id: collaboratorId } })
      if (!user) { set.status = 404; return { error: 'User not found' } }

      await db.document.update({ where: { id: documentId }, data: { users: { connect: { id: collaboratorId } } } })
      return { message: 'Collaborator added successfully' }
    } catch (err) {
      console.error('Error adding collaborator:', err)
      if (err instanceof z.ZodError) { set.status = 400; return { error: 'Invalid input', details: err.issues } }
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.delete('/api/document/:id/collaborators', async ({ headers, params, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const { userId: collaboratorId } = collaboratorSchema.parse(body)
      await db.document.update({ where: { id: documentId }, data: { users: { disconnect: { id: collaboratorId } } } })
      return { message: 'Collaborator removed successfully' }
    } catch (err) {
      console.error('Error removing collaborator:', err)
      if (err instanceof z.ZodError) { set.status = 400; return { error: 'Invalid input', details: err.issues } }
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  // Versions
  app.get('/api/document/:id/versions', async ({ headers, params, query, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const page = Number((query as any).page) || 1
      const limit = Number((query as any).limit) || 10
      const skip = (page - 1) * limit

      const versions = await db.version.findMany({
        where: { documentId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, name: true } } }
      })
      const total = await db.version.count({ where: { documentId } })

      return {
        versions,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      }
    } catch (err) {
      console.error('Error fetching versions:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  app.post('/api/document/:id/versions', async ({ headers, params, body, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const documentId = params.id

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const validated = createVersionSchema.parse(body)
      const version = await db.version.create({
        data: {
          content: validated.content as Prisma.InputJsonValue,
          document: { connect: { id: documentId } },
          user: { connect: { id: userId } }
        },
        include: { user: { select: { id: true, name: true } } }
      })
      await db.document.update({ where: { id: documentId }, data: { content: validated.content as Prisma.InputJsonValue } })
      set.status = 201
      return version
    } catch (err) {
      console.error('Error creating version:', err)
      if (err instanceof z.ZodError) { set.status = 400; return { error: 'Invalid input', details: err.issues } }
      set.status = 500
      return { error: 'Internal server error' }
    }
  })

  // Specific version
  app.get('/api/document/:id/versions/:versionId', async ({ headers, params, set }) => {
    try {
      const authHeader = headers['authorization'] as string | undefined
      if (!authHeader) { set.status = 401; return { error: 'Authentication required' } }
      const token = authHeader.split(' ')[1]
      const userId = await authenticateUser(token)
      const { id: documentId, versionId } = params as any

      const document = await db.document.findFirst({ where: { id: documentId, users: { some: { id: userId } } } })
      if (!document) { set.status = 404; return { error: 'Document not found' } }

      const version = await db.version.findFirst({
        where: { id: versionId, documentId },
        include: { user: { select: { id: true, name: true } } }
      })
      if (!version) { set.status = 404; return { error: 'Version not found' } }
      return version
    } catch (err) {
      console.error('Error fetching version:', err)
      set.status = 500
      return { error: 'Internal server error' }
    }
  })
}
