import { z } from 'zod'
import { createTRPCRouter, protectedProcedure } from '../trpc'
import { TRPCError } from '@trpc/server'
import { Prisma } from '@prisma/client'

const documentInputSchema = z.object({
  title: z.string(),
  icon: z.union([
    z.string().refine(
      (str) => {
        const emojiRegex = /^(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])$/;
        return emojiRegex.test(str);
      },
      'Must be a single emoji character'
    ),
    z.string().url('Must be a valid URL'),
    z.null()
  ]).nullable().optional(),
  coverImage: z.union([
    z.string().regex(/^linear-gradient\(.*\)$/, 'Must be a valid CSS gradient'),
    z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color'),
    z.string().url('Must be a valid URL'),
    z.null()
  ]).nullable().optional(),
  content: z.any(),
  position: z.object({
    x: z.number().finite().min(0).max(10000),
    y: z.number().finite().min(0).max(10000)
  })
})

export const documentRouter = createTRPCRouter({
  create: protectedProcedure
    .input(documentInputSchema)
    .mutation(async ({ ctx, input }) => {
      console.log('Document create procedure called');
      console.log('Input received:', JSON.stringify(input, null, 2));
      console.log('Current user:', ctx.userId);

      if (!input || !input.title || !input.content) {
        console.error('Invalid input:', input);
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid input: title and content are required',
        });
      }

      try {
        const newDocument = await ctx.prisma.document.create({
          data: {
            title: input.title,
            icon: input.icon,
            coverImage: input.coverImage,
            content: input.content as Prisma.InputJsonValue,
            position: input.position,
            users: {
              connect: { id: ctx.userId },
            },
            versions: {
              create: {
                content: input.content as Prisma.InputJsonValue,
                user: { connect: { id: ctx.userId } },
              },
            },
          },
        });

        console.log('Document created successfully:', JSON.stringify(newDocument, null, 2));
        return newDocument;
      } catch (error) {
        console.error('Error creating document:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to create document: ${error.message}`,
            cause: error,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred while creating the document',
          cause: error,
        });
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      console.log('Document delete procedure called');
      console.log('Document ID:', input.id);
      console.log('Current user:', ctx.userId);

      try {
        // First check if the user has access to this document
        const document = await ctx.prisma.document.findFirst({
          where: {
            id: input.id,
            users: {
              some: {
                id: ctx.userId
              }
            }
          }
        });

        if (!document) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found or you do not have permission to delete it',
          });
        }

        // Delete the document and all related versions
        await ctx.prisma.document.delete({
          where: {
            id: input.id,
          },
        });

        console.log('Document deleted successfully:', input.id);
        return { success: true, id: input.id };
      } catch (error) {
        console.error('Error deleting document:', error);
        if (error instanceof TRPCError) {
          throw error;
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to delete document: ${error.message}`,
            cause: error,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred while deleting the document',
          cause: error,
        });
      }
    }),

  // ... other procedures remain unchanged
});

