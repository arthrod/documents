import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { ZodError } from 'zod';
import prisma from '../db';
import { authenticateUser } from '../auth';

export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  const { req } = opts;
  const token = req.headers.get('authorization')?.split(' ')[1];

  console.log('Creating tRPC context');
  console.log('Authorization token:', token ? 'Present' : 'Missing');

  let userId: string | null = null;
  try {
    userId = await authenticateUser(token);
    console.log('User authenticated, userId:', userId);
  } catch (error) {
    console.error('Authentication error:', error);
  }

  return {
    prisma,
    userId,
    req,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
    },
  });
});

