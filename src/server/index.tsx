import { Elysia } from 'elysia';
import { html, Html } from '@elysiajs/html';
import cors from '@elysiajs/cors';
import { trpc } from '@elysiajs/trpc';
import { appRouter } from './api/root';
import { createTRPCContext } from './api/trpc';
import { db } from './db';
import { authenticateUser } from './auth';
import { createPresignedUploadUrl, getS3Client } from '@/lib/s3';
import { randomUUID } from 'crypto';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

async function requireUser(req: Request) {
  const auth = req.headers.get('authorization');
  if (!auth) throw new Error('Authentication required');
  const token = auth.split(' ')[1];
  if (!token) throw new Error('Invalid authorization format');
  return authenticateUser(token);
}

const app = new Elysia()
  .use(html())
  .use(cors())
  .use(trpc(appRouter, { createContext: createTRPCContext, endpoint: '/api/trpc' }))
  .get('/', () => (
    <html lang="en">
      <head>
        <title>Plate API</title>
      </head>
      <body>
        <h1>Plate API</h1>
      </body>
    </html>
  ))
  .get('/api/healthcheck', async ({ set }: any) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: 'healthy' };
    } catch (error) {
      console.error('Healthcheck failed:', error);
      set.status = 500;
      return { status: 'unhealthy', error: 'Database connection failed' };
    }
  })
  .post('/api/upload', async ({ request, set }: any) => {
    try {
      const userId = await requireUser(request);
      const { fileName, fileType, fileSize } = await request.json() as { fileName: string; fileType: string; fileSize: number };
      if (!fileName || !fileType || !fileSize) {
        set.status = 400;
        return { error: 'Missing required fields' };
      }
      const fileId = randomUUID();
      const key = `${userId}/${fileId}/${fileName}`;
      const presignedData = await createPresignedUploadUrl(key, fileType);
      const file = await db.file.create({
        data: {
          id: fileId,
          userId,
          name: fileName,
          type: fileType,
          size: fileSize,
          key,
          url: `https://${presignedData.bucket}.s3.${presignedData.region}.amazonaws.com/${key}`,
          status: 'pending',
          metadata: {
            fileType,
            description: '',
            version: 1
          }
        }
      });
      return {
        fileId: file.id,
        uploadUrl: presignedData.url,
        fields: presignedData.fields
      };
    } catch (error) {
      console.error('Error handling upload request:', error);
      set.status = 500;
      return { error: 'Internal server error' };
    }
  })
  .post('/api/files/:id/complete', async ({ request, params, set }: any) => {
    try {
      const userId = await requireUser(request);
      const fileId = params.id;
      const file = await db.file.findFirst({ where: { id: fileId, userId } });
      if (!file) {
        set.status = 404;
        return { error: 'File not found' };
      }
      const updated = await db.file.update({ where: { id: fileId }, data: { status: 'approved' } });
      return updated;
    } catch (error) {
      console.error('Error completing file upload:', error);
      set.status = 500;
      return { error: 'Internal server error' };
    }
  })
  .get('/api/files', async ({ request, query, set }: any) => {
    try {
      const userId = await requireUser(request);
      const schema = z.object({
        page: z.coerce.number().optional().default(1),
        limit: z.coerce.number().optional().default(10),
        type: z.string().optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        search: z.string().optional()
      });
      const { page, limit, type, status, search } = schema.parse(query);
      const where: any = { userId };
      if (type) where.type = type;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { type: { contains: search, mode: 'insensitive' } }
        ];
      }
      const skip = (page - 1) * limit;
      const [files, total] = await Promise.all([
        db.file.findMany({ where, skip, take: limit, orderBy: { uploadedAt: 'desc' }, select: { id: true, name: true, type: true, size: true, url: true, key: true, status: true, uploadedAt: true, updatedAt: true, metadata: true } }),
        db.file.count({ where })
      ]);
      const s3Client = getS3Client();
      const bucket = process.env.AWS_BUCKET_NAME!;
      const filesWithUrls = await Promise.all(files.map(async (file) => {
        try {
          const command = new GetObjectCommand({ Bucket: bucket, Key: file.key, ResponseContentDisposition: 'inline' });
          const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
          return { ...file, url };
        } catch {
          return file;
        }
      }));
      const totalPages = Math.ceil(total / limit);
      return {
        files: filesWithUrls,
        pagination: { total, page, totalPages, hasMore: page < totalPages }
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        set.status = 400;
        return { error: 'Invalid query parameters', details: error.issues };
      }
      console.error('Error listing files:', error);
      set.status = 500;
      return { error: 'Internal server error' };
    }
  })
  .get('/api/files/:id', async ({ request, params, set }: any) => {
    try {
      const userId = await requireUser(request);
      const file = await db.file.findFirst({ where: { id: params.id, userId } });
      if (!file) {
        set.status = 404;
        return { error: 'File not found' };
      }
      const s3Client = getS3Client();
      const bucket = process.env.AWS_BUCKET_NAME!;
      const command = new GetObjectCommand({ Bucket: bucket, Key: file.key, ResponseContentDisposition: 'inline' });
      try {
        file.url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      } catch {
        // ignore
      }
      return file;
    } catch (error) {
      console.error('Error fetching file:', error);
      set.status = 500;
      return { error: 'Internal server error' };
    }
  })
  .patch('/api/files/:id', async ({ request, params, set }: any) => {
    try {
      const userId = await requireUser(request);
      const fileId = params.id;
      const body = await request.json();
      const schema = z.object({
        name: z.string().optional(),
        metadata: z.object({ fileType: z.string().optional(), description: z.string().optional() }).optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional()
      });
      const input = schema.parse(body);
      const file = await db.file.findFirst({ where: { id: fileId, userId } });
      if (!file) {
        set.status = 404;
        return { error: 'File not found' };
      }
      const currentMetadata = file.metadata as any || { fileType: file.type, description: '', version: 1 };
      const updated = await db.file.update({
        where: { id: fileId },
        data: {
          ...(input.name && { name: input.name }),
          ...(input.status && { status: input.status }),
          ...(input.metadata && { metadata: { fileType: input.metadata.fileType ?? currentMetadata.fileType, description: input.metadata.description ?? currentMetadata.description, version: currentMetadata.version } })
        }
      });
      return updated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        set.status = 400;
        return { error: 'Invalid request data', details: error.issues };
      }
      console.error('Error updating file:', error);
      set.status = 500;
      return { error: 'Failed to update file' };
    }
  })
  .delete('/api/files/:id', async ({ request, params, set }: any) => {
    try {
      const userId = await requireUser(request);
      const file = await db.file.findFirst({ where: { id: params.id, userId } });
      if (!file) {
        set.status = 404;
        return { error: 'File not found' };
      }
      const s3Client = getS3Client();
      const bucket = process.env.AWS_BUCKET_NAME!;
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.key }));
      await db.file.delete({ where: { id: params.id } });
      set.status = 204;
      return null;
    } catch (error) {
      console.error('Error deleting file:', error);
      set.status = 500;
      return { error: 'Internal server error' };
    }
  })
  .listen(process.env.PORT ? Number(process.env.PORT) : 8080);

export type App = typeof app;
