// Standalone replacement for "@hatch/space-sdk/client".
// createActionClient posts {action, args} to ./actions — the exact
// protocol the Muse SDK used — and returns the typed response.
// spaceQueryClient keeps the same conservative defaults as the SDK
// (30s stale time, no refetch on window focus). getSpaceViewer has no
// Muse viewer in the standalone build, so it returns null; the app
// identifies players by playerKey, not by the Muse viewer.
import { QueryClient } from "@tanstack/react-query";

export class SpaceActionError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly retrySafe: boolean;
  readonly code?: string;
  readonly issues: readonly unknown[];
  readonly detail: string;
  constructor(message: string, status: number, retryAfterMs?: number, retrySafe = false, code?: string, issues: readonly unknown[] = [], detail = "") {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retrySafe = retrySafe;
    this.code = code;
    this.issues = issues;
    this.detail = detail || message;
  }
}

export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

export function installAuditSettleProbe(queryClient: QueryClient = spaceQueryClient): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__hatchAuditSettle = () => queryClient.isFetching() + queryClient.isMutating();
}
installAuditSettleProbe();

export function installSpaceQueryInvalidationListener(): void {
  // No-op standalone: the server has no cross-client invalidation
  // bridge. Mutations refetch through React Query in the app itself.
}

export function getSpaceViewer(): Promise<null> {
  return Promise.resolve(null);
}
export function subscribeSpaceViewer(): () => void {
  return () => undefined;
}
export function useSpaceViewer(): null {
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as unknown as { toBase64?: () => string };
  if (typeof native.toBase64 === "function") return native.toBase64();
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

export async function fileToBase64(file: File | Blob): Promise<{ dataBase64: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { dataBase64: bytesToBase64(bytes), mimeType: file.type || "application/octet-stream" };
}

import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";

export type ApiRequest<C extends Record<string, (args: never) => Promise<unknown>>, K extends keyof C> = Parameters<C[K]>[0];
export type ApiResponse<C extends Record<string, (args: never) => Promise<unknown>>, K extends keyof C> = Awaited<ReturnType<C[K]>>;

export type ActionRequest<A extends { request: ZodType }> = ZodInput<A["request"]>;
export type ActionResponse<A extends { response: ZodType }> = ZodOutput<A["response"]>;

type ClientActionShape = { request: ZodType; response: ZodType };
export type ActionClient<A extends Record<string, ClientActionShape>> = {
  [K in keyof A]: (args: ZodInput<A[K]["request"]>) => Promise<ActionResponse<A[K]>>;
};

interface ClientOptions {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

export function createActionClient<A extends Record<string, ClientActionShape>>(options: ClientOptions = {}): ActionClient<A> {
  const endpoint = options.endpoint ?? "./actions";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        if (name === "then" || name === "catch" || name === "finally") return undefined;
        return async (args: unknown) => {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: name, args: args ?? {}, actionCallId: crypto.randomUUID() }),
          });
          const body = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string };
          if (!response.ok || (body && typeof body === "object" && "error" in body && body.error)) {
            throw new SpaceActionError(String(body?.error || `action ${name} failed`), response.status || 500, undefined, false, undefined, [], JSON.stringify(body));
          }
          return body.data;
        };
      },
    },
  ) as never;
}
