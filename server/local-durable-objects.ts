// In-process Durable Objects for the Node runtime (EdgeOne Pages / Aliyun FC /
// Tencent SCF / self-hosting).
//
// The shared Worker code keeps its storage logic inside Durable Objects:
//   - `NotificationsHub`      realtime push + backup/restore progress fan-out
//   - `BackupTransferRunner`  manual/scheduled backup runs, remote restore,
//                             attachment upload/download chunks
//
// Workers get these from the platform. Plain Node has no Durable Objects, and
// the previous port answered every DO call with HTTP 501
// (`durable-objects-unavailable`). That broke the backup centre completely:
// remote restore, manual runs and scheduled runs all failed, and the admin UI
// surfaced the raw 501 body to the user.
//
// We do not want a second implementation of backup logic, so instead we provide
// a tiny local runtime that instantiates the *real* Durable Object classes with
// a synchronous, in-memory `state.storage`. Semantics we keep:
//   - one instance per object name, kept for the process lifetime (mirrors DO
//     single-instance-per-name, minus eviction);
//   - `storage.get/put/delete/list/transaction` + alarm bookkeeping;
//   - `blockConcurrencyWhile` runs inline.
// Semantics we cannot provide on a plain HTTP server:
//   - WebSocket hibernation. Upgrade requests are rejected with 501 so
//     Bitwarden clients fall back to polling; everything else (token issuing,
//     `/internal/notify`, `/internal/online`) still works in memory, which is
//     what the backup progress notifications rely on.
//
// Because state is in memory, it is per-process and lost on cold start. That is
// acceptable: it only carries short-lived data (60 s websocket tokens, the
// 10 min backup job lease that prevents two concurrent runs).

import type { Env } from '../src/types';
import { BackupTransferRunner } from '../src/durable/backup-transfer-runner';
import { NotificationsHub } from '../src/durable/notifications-hub';

export interface DurableObjectLike {
  fetch(request: Request): Promise<Response>;
}

export type DurableObjectFactory = (ctx: unknown, env: Env) => DurableObjectLike;

type StorageListOptions = { prefix?: string; limit?: number; reverse?: boolean };

/**
 * Minimal stand-in for `DurableObjectStorage`: same method surface the Worker
 * code uses, backed by a Map.
 */
class MemoryDurableObjectStorage {
  private readonly values = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async getMany<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const key of keys) {
      if (this.values.has(key)) result.set(key, this.values.get(key) as T);
    }
    return result;
  }

  async put<T = unknown>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === 'object' && key !== null) {
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.values.set(entryKey, entryValue);
      }
      return;
    }
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let removed = 0;
      for (const entry of key) {
        if (this.values.delete(entry)) removed += 1;
      }
      return removed;
    }
    return this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async list<T = unknown>(options: StorageListOptions = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? '';
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : Number.POSITIVE_INFINITY;
    let keys = Array.from(this.values.keys()).filter((key) => key.startsWith(prefix)).sort();
    if (options.reverse) keys = keys.reverse();
    if (Number.isFinite(limit)) keys = keys.slice(0, limit);
    const result = new Map<string, T>();
    for (const key of keys) result.set(key, this.values.get(key) as T);
    return result;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = typeof at === 'number' ? at : at.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async transaction<T>(closure: (txn: MemoryDurableObjectStorage) => Promise<T>): Promise<T> {
    // Single-threaded Node + no await inside the closures used by the Worker
    // code, so running the closure directly is already atomic per instance.
    return closure(this);
  }
}

function createState(name: string, storage: MemoryDurableObjectStorage) {
  return {
    id: { name, toString: () => name },
    storage,
    blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> => closure(),
    waitUntil: (_promise: Promise<unknown>): void => {
      void _promise;
    },
    acceptWebSocket: (): never => {
      throw new Error('WebSockets are not supported on the Node runtime');
    },
    getWebSockets: (): never[] => [],
    setWebSocketAutoResponse: (): void => {},
    getWebSocketAutoResponse: (): null => null,
    setHibernatableWebSocketEventTimeout: (): void => {},
  };
}

export interface LocalDurableObjectNamespace {
  idFromName(name: string): { name: string };
  idFromString(id: string): { name: string };
  get(id: { name: string }): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Build a namespace that resolves each object name to a lazily constructed,
 * process-scoped instance of `factory`.
 */
export function createLocalDurableObjectNamespace(
  label: string,
  factory: DurableObjectFactory,
  getEnv: () => Env
): LocalDurableObjectNamespace {
  const instances = new Map<string, Promise<DurableObjectLike>>();
  const storages = new Map<string, MemoryDurableObjectStorage>();

  const ensureInstance = (name: string): Promise<DurableObjectLike> => {
    const cached = instances.get(name);
    if (cached) return cached;

    let storage = storages.get(name);
    if (!storage) {
      storage = new MemoryDurableObjectStorage();
      storages.set(name, storage);
    }
    const state = createState(name, storage);

    const pending: Promise<DurableObjectLike> = (async () => factory(state, getEnv()))();
    instances.set(name, pending);
    // A constructor failure must not poison the name forever: drop the entry so
    // the next call retries (the caller still sees the 500).
    void pending.catch(() => {
      if (instances.get(name) === pending) instances.delete(name);
    });
    return pending;
  };

  const toStub = (name: string) => ({
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        // Hibernatable WebSockets need the Workers runtime. Answer with a clear
        // 501 instead of throwing inside the object so clients fall back to
        // polling without a server-side stack trace every reconnect attempt.
        return jsonError(`${label} does not support WebSocket upgrades on the Node runtime`, 501);
      }
      let instance: DurableObjectLike;
      try {
        instance = await ensureInstance(name);
      } catch (error) {
        return jsonError(
          `${label} failed to start: ${error instanceof Error ? error.message : String(error)}`,
          500
        );
      }
      return instance.fetch(request);
    },
  });

  return {
    idFromName(name: string) {
      return { name: String(name) };
    },
    idFromString(id: string) {
      return { name: String(id) };
    },
    get(id: { name: string }) {
      return toStub(String(id?.name ?? ''));
    },
  };
}

/** Install the Workers globals the Durable Object classes touch. */
export function installDurableObjectGlobals(): void {
  const globals = globalThis as unknown as {
    WebSocketRequestResponsePair?: unknown;
    WebSocketPair?: unknown;
  };
  if (!globals.WebSocketRequestResponsePair) {
    globals.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
      constructor(
        public readonly request: string,
        public readonly response: string
      ) {}
    };
  }
}

export function createLocalNotificationsHubNamespace(getEnv: () => Env): LocalDurableObjectNamespace {
  installDurableObjectGlobals();
  return createLocalDurableObjectNamespace(
    'NOTIFICATIONS_HUB',
    (ctx, env) => new NotificationsHub(ctx as never, env),
    getEnv
  );
}

export function createLocalBackupRunnerNamespace(getEnv: () => Env): LocalDurableObjectNamespace {
  return createLocalDurableObjectNamespace(
    'BACKUP_TRANSFER_RUNNER',
    (ctx, env) => new BackupTransferRunner(ctx as never, env),
    getEnv
  );
}
