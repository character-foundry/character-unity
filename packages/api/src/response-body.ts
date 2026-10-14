import type { MiddlewareHandler } from 'hono';

/** Dispose response streams that will never have a consumer: Hono drops HEAD
 * bodies, and a Node client may disconnect before its route returns a body. */
export const disposeUnusedResponseBody: MiddlewareHandler = async (context, next) => {
  await next();
  if (!context.res.body) return;
  const signal = context.req.raw.signal;
  if (context.req.method !== 'HEAD' && !signal.aborted) return;
  const response = context.res;
  await response.body!.cancel(signal.aborted ? signal.reason : undefined);
  context.res = new Response(null, response);
};
