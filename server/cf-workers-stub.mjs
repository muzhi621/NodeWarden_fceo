// Stub for the Workers-only `cloudflare:workers` module.
//
// The shared code imports `DurableObject` from it; on a plain Node host the
// class only has to exist so the in-process Durable Objects (see
// ./local-durable-objects.ts) can extend it. Bundling this file in place of the
// real specifier keeps the produced ESM free of `cloudflare:` imports, which a
// platform bundler (EdgeOne Pages) cannot resolve — the FC package instead
// registers ./cf-stub-loader.mjs at runtime.

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export function waitUntil(promise) {
  void promise;
}

export class WorkerEntrypoint {}
export class RpcTarget {}

export default {};
