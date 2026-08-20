import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type { CallbackIntent, CreateIntent, RequestBinding } from "./types.js";

export type StoreEntry<T> = { key: string; value: T };
export type KeyedStore<T> = {
  register(key: string, value: T, options?: { ttlMs?: number }): Promise<void>;
  registerIfAbsent(key: string, value: T, options?: { ttlMs?: number }): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<StoreEntry<T>[]>;
};

export type PluginStores = {
  creates: KeyedStore<CreateIntent>;
  bindings: KeyedStore<RequestBinding>;
  callbacks: KeyedStore<CallbackIntent>;
  leases: KeyedStore<{ owner: string; createdAt: number }>;
};

export function openPluginStores(api: OpenClawPluginApi): PluginStores {
  try {
    return {
      creates: api.runtime.state.openKeyedStore<CreateIntent>({
        namespace: "book-create-intents",
        maxEntries: 500,
        overflowPolicy: "reject-new",
      }),
      bindings: api.runtime.state.openKeyedStore<RequestBinding>({
        namespace: "book-request-bindings",
        maxEntries: 2_000,
        overflowPolicy: "reject-new",
      }),
      callbacks: api.runtime.state.openKeyedStore<CallbackIntent>({
        namespace: "book-callback-intents",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
        defaultTtlMs: 7 * 24 * 60 * 60_000,
      }),
      leases: api.runtime.state.openKeyedStore<{ owner: string; createdAt: number }>({
        namespace: "book-poller-leases",
        maxEntries: 10,
        defaultTtlMs: 30_000,
      }),
    };
  } catch {
    throw new Error(
      "Viktor Audiobooks requires a trusted OpenClaw installation with native keyed stores.",
    );
  }
}
