/**
 * tRPC router for resource-gateway
 * 
 * Provides typed API for browser session management.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'http';
import { getUserIdFromApiKey } from './redis.ts';

// ── Config ────────────────────────────────────────────────────────────────────

const BROWSER_HTTP = process.env.BROWSER_HTTP ??
  (process.env.NODE_ENV === 'production' ? 'http://browser:8086' : 'http://localhost:8086');

// ── Context ───────────────────────────────────────────────────────────────────

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  userId: string | null;
}

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return null;
}

export async function createContext({ req, res }: { req: IncomingMessage; res: ServerResponse }): Promise<Context> {
  const apiKey = extractApiKey(req);
  const userId = apiKey ? await getUserIdFromApiKey(apiKey) : null;
  return { req, res, userId };
}

// ── tRPC init ─────────────────────────────────────────────────────────────────

const t = initTRPC.context<Context>().create();

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' });
  return next({ ctx: { ...ctx, userId: ctx.userId as string } });
});

const protectedProcedure = t.procedure.use(isAuthed);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function browsingFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BROWSER_HTTP}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840).default(1280),
  height: z.number().int().min(240).max(2160).default(720),
});

const sessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  cdpUrl: z.string().optional(),
  createdAt: z.string().optional(),
});

// ── Router ────────────────────────────────────────────────────────────────────

const browserRouter = t.router({
  create: protectedProcedure
    .input(z.object({ viewport: viewportSchema.optional() }))
    .output(sessionSchema)
    .mutation(async ({ ctx, input }) => {
      const { ok, data } = await browsingFetch('/api/cdp-sessions', {
        method: 'POST',
        body: JSON.stringify({ userId: ctx.userId, viewport: input.viewport }),
      });
      if (!ok || !data) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create browser session' });
      const host = ctx.req.headers.host ?? 'localhost:6000';
      const proto = ctx.req.headers['x-forwarded-proto'] as string | undefined;
      const protocol = proto === 'https' ? 'wss' : host.includes('localhost') ? 'ws' : 'wss';
      return { ...data, cdpUrl: `${protocol}://${host}/browser/${data.sessionId}` };
    }),

  list: protectedProcedure
    .output(z.array(sessionSchema))
    .query(async ({ ctx }) => {
      const { data } = await browsingFetch(`/api/cdp-sessions?userId=${ctx.userId}`);
      return data ?? [];
    }),

  get: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .output(sessionSchema.nullable())
    .query(async ({ ctx, input }) => {
      const { ok, data } = await browsingFetch(`/api/cdp-sessions/${input.sessionId}`);
      if (!ok || data?.userId !== ctx.userId) return null;
      return data;
    }),

  delete: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { ok, data } = await browsingFetch(`/api/cdp-sessions/${input.sessionId}`);
      if (!ok || data?.userId !== ctx.userId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      await browsingFetch(`/api/cdp-sessions/${input.sessionId}`, { method: 'DELETE' });
      return { success: true };
    }),

  deleteAll: protectedProcedure
    .output(z.object({ deleted: z.number() }))
    .mutation(async ({ ctx }) => {
      const { data } = await browsingFetch(`/api/cdp-sessions?userId=${ctx.userId}`, { method: 'DELETE' });
      return data ?? { deleted: 0 };
    }),
});

export const appRouter = t.router({ browser: browserRouter });
export type AppRouter = typeof appRouter;
