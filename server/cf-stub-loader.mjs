// Node loader hook: map the Workers-only `cloudflare:` specifiers to stubs so
// the shared code (which imports Durable Object helpers) loads under Node.

const CF_WORKERS_STUB =
  'data:text/javascript,' +
  encodeURIComponent(
    'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' +
      'export function waitUntil(promise) { void promise; }' +
      'export class WorkerEntrypoint {}' +
      'export class RpcTarget {}' +
      'export default {}'
  );

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { shortCircuit: true, url: CF_WORKERS_STUB };
  }
  return next(specifier, context);
}
