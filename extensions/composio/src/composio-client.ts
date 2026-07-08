// Config normalization and a memoized Composio client for the OpenClaw plugin.
// Kept separate from the plugin entry so index.ts stays declarative and the
// runtime dependency (@composio/core) is only touched inside tool execution.
import { Composio } from "@composio/core";

/** Default toolkits exposed when config does not set an explicit allowlist. */
export const DEFAULT_ALLOWED_TOOLKITS = ["github", "gmail"] as const;

/** Default number of tools returned by composio_search. */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Composio user id used when config does not set one. */
export const DEFAULT_USER_ID = "default";

/** Minimal shape of a raw Composio tool used by this plugin. */
export type RawComposioTool = {
  slug: string;
  name?: string;
  description?: string;
  toolkit?: { slug?: string };
};

/** Normalized plugin configuration with defaults applied. */
export type ResolvedComposioConfig = {
  apiKey: string | undefined;
  userId: string;
  allowedToolkits: string[];
  searchLimit: number;
  requireApproval: boolean;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Resolve raw plugin config plus environment fallback into a typed config. */
export function resolveComposioConfig(
  raw: Record<string, unknown> | undefined,
): ResolvedComposioConfig {
  const config = raw ?? {};
  return {
    apiKey: readString(config.apiKey) ?? readString(process.env.COMPOSIO_API_KEY),
    userId: readString(config.userId) ?? DEFAULT_USER_ID,
    allowedToolkits: readStringArray(config.allowedToolkits) ?? [...DEFAULT_ALLOWED_TOOLKITS],
    searchLimit: readPositiveInteger(config.searchLimit) ?? DEFAULT_SEARCH_LIMIT,
    requireApproval: config.requireApproval !== false,
  };
}

/** True when a toolkit slug is in the allowlist (case-insensitive). */
export function isToolkitAllowed(toolkit: string | undefined, allowed: string[]): boolean {
  return typeof toolkit === "string" && allowed.includes(toolkit.toLowerCase());
}

let cachedApiKey: string | undefined;
let cachedClient: Composio | undefined;

/**
 * Build (or reuse) a Composio client for the resolved API key. The client is
 * memoized per api key so repeated tool calls do not re-instantiate the SDK.
 */
export function getComposioClient(config: ResolvedComposioConfig): Composio {
  if (!config.apiKey) {
    throw new Error(
      "Composio is not configured. Set the plugin `apiKey` or the COMPOSIO_API_KEY environment variable.",
    );
  }
  if (cachedClient && cachedApiKey === config.apiKey) {
    return cachedClient;
  }
  cachedClient = new Composio({ apiKey: config.apiKey });
  cachedApiKey = config.apiKey;
  return cachedClient;
}
