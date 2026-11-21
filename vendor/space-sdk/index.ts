// Standalone replacement for "@hatch/space-sdk" (the Muse platform SDK).
// Same contract the ViceSunshine server code imports: defineAction + z,
// the Ctx type, and the action-module shape. The platform Ctx is built
// by server/standalone/ctx.ts — this file only defines the contract.
import { z } from "zod";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export { z };
export type { JsonValue } from "./types";

export const ACTION_BRAND = "@hatch/space-sdk/action/v1" as const;

export interface BlobPutOptions {
  readonly contentType?: string;
  readonly public?: boolean;
}
export interface BlobUrlOptions {
  readonly expiresInSeconds?: number;
  readonly public?: boolean;
}
export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly visibility: "private" | "public";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly public: boolean;
}
export type BlobPutData = string | ArrayBuffer | ArrayBufferView | Blob;
export interface BlobClient {
  put(key: string, data: BlobPutData, options?: BlobPutOptions): Promise<void>;
  getUrl(key: string, options?: BlobUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

export interface AgentTaskOptions {
  readonly expectsAction?: string;
  readonly dedupeKey?: string;
  readonly allowParallel?: boolean;
}
export type AgentTaskResult =
  | { ok: true; taskId: string; agentId: string; messageId: string }
  | { ok: false; error: string };
export interface AgentClient {
  spawnTask(message: string, options?: AgentTaskOptions): Promise<AgentTaskResult>;
  send(message: string, options?: AgentTaskOptions): Promise<AgentTaskResult>;
  status(taskId: string): Promise<{ taskId: string; status: string }>;
}

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly { dataBase64: string; mimeType?: "image/jpeg" | "image/png"; filename?: string; caption?: string }[];
}
export interface InferenceClient {
  complete<T extends z.ZodType>(prompt: string, options: InferenceCompleteOptions<T>): Promise<z.infer<T>>;
}

export interface SpaceToolClient {
  web_search(query: string, options?: Record<string, unknown>): Promise<unknown>;
  generate_media(prompt: string, options?: { key?: string; orientation?: string }): Promise<{ blobKey: string }>;
  [key: string]: unknown;
}

export interface PortableCtx {
  readonly slug: string;
  readonly invocationId: string;
  readonly spaceDir: string;
  // Bun's drizzle driver has no batch(); the standalone Ctx adds one
  // (server/standalone/ctx.ts) that runs the statements in order.
  readonly db: <TSchema extends Record<string, unknown> = Record<string, never>>() => BunSQLiteDatabase<TSchema> & {
    batch: (stmts: readonly unknown[]) => Promise<unknown[]>;
  };
  readonly viewer?: unknown;
  readonly blobs: BlobClient;
  executePrivileged?: <C extends { name: string }>(contract: C, args: unknown) => Promise<unknown>;
}

export interface Ctx extends PortableCtx {
  readonly agent: AgentClient;
  readonly inference: InferenceClient;
  readonly tool: SpaceToolClient;
  emit(data: unknown): void;
  invalidateQueries(invalidation?: unknown): void;
}

export interface ActionDefinition<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  readonly __brand: typeof ACTION_BRAND;
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export type ActionsModule = Record<
  string,
  Omit<ActionDefinition, "handler"> & { handler: (ctx: Ctx, args: never) => Promise<unknown> }
>;

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(spec: {
  request: Req;
  response: Res;
  description?: string;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return { __brand: ACTION_BRAND, request: spec.request, response: spec.response, description: spec.description, handler: spec.handler };
}

export function isAction(value: unknown): value is ActionDefinition {
  return typeof value === "object" && value !== null && (value as { __brand?: unknown }).__brand === ACTION_BRAND;
}

export function actionDescription(definition: Pick<ActionDefinition, "description">): string | undefined {
  return definition.description;
}

export const INFERENCE_SCHEMA_ERROR_BRAND = "@hatch/space-sdk/InferenceSchemaError/v1" as const;
export class InferenceSchemaError extends Error {
  readonly __brand = INFERENCE_SCHEMA_ERROR_BRAND;
  readonly issues: readonly unknown[];
  constructor(issues: readonly unknown[]) {
    super("Inference output did not match the required schema");
    this.issues = issues;
  }
  static is(value: unknown): value is InferenceSchemaError {
    return value instanceof InferenceSchemaError || (typeof value === "object" && value !== null && (value as { __brand?: unknown }).__brand === INFERENCE_SCHEMA_ERROR_BRAND);
  }
}
