// Composio plugin entrypoint. Registers two agent tools (composio_search,
// composio_execute) that are optional (opt-in via tools.allow) and gates every
// composio_execute call behind a per-call approval. Tool execution is confined
// to an allowlist of Composio toolkits so a paired remote user cannot invoke
// arbitrary connected-account actions.
import type { JsonSchemaObject } from "openclaw/plugin-sdk/json-schema-runtime";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  getComposioClient,
  isToolkitAllowed,
  type RawComposioTool,
  resolveComposioConfig,
} from "./src/composio-client.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string parameter: ${key}`);
  }
  return value.trim();
}

// Inlined tool-result helpers. The published gateway package does not export
// openclaw/plugin-sdk/tool-results, so we build the AgentToolResult shape here.
function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function jsonResult(payload: unknown) {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

export default definePluginEntry({
  id: "composio",
  name: "Composio",
  description: "Expose an allowlisted set of Composio tools to the agent behind per-call approval.",
  configSchema: buildJsonPluginConfigSchema(
    Type.Object(
      {
        apiKey: Type.Optional(
          Type.String({
            description:
              "Composio API key. Falls back to the COMPOSIO_API_KEY environment variable.",
          }),
        ),
        userId: Type.Optional(
          Type.String({
            description:
              "Composio user id used to resolve the connected account for tool execution.",
          }),
        ),
        allowedToolkits: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Allowlist of Composio toolkit slugs (lowercase), for example github or gmail.",
          }),
        ),
        searchLimit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Maximum number of tools returned by composio_search.",
          }),
        ),
        requireApproval: Type.Optional(
          Type.Boolean({
            description:
              "Require per-call user approval before composio_execute runs. Defaults to true.",
          }),
        ),
      },
      { additionalProperties: false },
    ) as unknown as JsonSchemaObject,
  ),
  register(api) {
    api.registerTool(
      {
        name: "composio_search",
        label: "Composio Search",
        description:
          "Search for Composio tools available within the configured toolkit allowlist. Returns tool slugs to pass to composio_execute.",
        parameters: Type.Object({
          query: Type.String({
            description: "Natural-language description of the task, e.g. 'create a github issue'.",
          }),
          toolkit: Type.Optional(
            Type.String({
              description: "Restrict the search to a single allowlisted toolkit slug.",
            }),
          ),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, description: "Maximum tools to return." }),
          ),
        }),
        async execute(_toolCallId, rawParams, signal) {
          const params = asRecord(rawParams);
          const config = resolveComposioConfig(api.pluginConfig);
          const client = getComposioClient(config);

          const requestedToolkit =
            typeof params.toolkit === "string" ? params.toolkit.trim().toLowerCase() : undefined;
          if (requestedToolkit && !isToolkitAllowed(requestedToolkit, config.allowedToolkits)) {
            throw new Error(
              `Toolkit "${requestedToolkit}" is not allowlisted. Allowed toolkits: ${config.allowedToolkits.join(", ")}.`,
            );
          }
          const toolkits = requestedToolkit ? [requestedToolkit] : config.allowedToolkits;
          const limit =
            typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0
              ? params.limit
              : config.searchLimit;

          const tools = (await client.tools.getRawComposioTools(
            { toolkits, search: requireStringParam(params, "query"), limit },
            undefined,
            signal ? { signal } : undefined,
          )) as unknown as RawComposioTool[];

          const results = tools
            .filter((tool) => isToolkitAllowed(tool.toolkit?.slug, config.allowedToolkits))
            .map((tool) => ({
              slug: tool.slug,
              name: tool.name,
              toolkit: tool.toolkit?.slug,
              description: tool.description,
            }));

          if (results.length === 0) {
            return textResult(
              `No allowlisted Composio tools matched "${params.query}". Allowed toolkits: ${config.allowedToolkits.join(", ")}.`,
              { results },
            );
          }
          return jsonResult({ results });
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "composio_execute",
        label: "Composio Execute",
        description:
          "Execute a Composio tool by slug (from composio_search) against the configured connected account. Restricted to the toolkit allowlist and gated by per-call approval.",
        parameters: Type.Object({
          tool_slug: Type.String({
            description: "Composio tool slug, e.g. GITHUB_CREATE_AN_ISSUE.",
          }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Arguments object for the tool, matching its Composio input schema.",
            }),
          ),
        }),
        async execute(_toolCallId, rawParams, signal) {
          const params = asRecord(rawParams);
          const config = resolveComposioConfig(api.pluginConfig);
          const client = getComposioClient(config);
          const slug = requireStringParam(params, "tool_slug");
          const args = asRecord(params.arguments);

          const requestOptions = signal ? { signal } : undefined;
          const tool = (await client.tools.getRawComposioToolBySlug(
            slug,
            undefined,
            requestOptions,
          )) as unknown as RawComposioTool;
          const toolkit = tool.toolkit?.slug;
          if (!isToolkitAllowed(toolkit, config.allowedToolkits)) {
            throw new Error(
              `Tool "${slug}" belongs to toolkit "${toolkit ?? "unknown"}", which is not allowlisted. Allowed toolkits: ${config.allowedToolkits.join(", ")}.`,
            );
          }

          const response = await client.tools.execute(
            slug,
            { userId: config.userId, arguments: args },
            requestOptions,
          );
          return jsonResult(response);
        },
      },
      { optional: true },
    );

    api.on("before_tool_call", (event) => {
      if (event.toolName !== "composio_execute") {
        return;
      }
      const config = resolveComposioConfig(api.pluginConfig);
      if (!config.requireApproval) {
        return;
      }
      const slug = typeof event.params.tool_slug === "string" ? event.params.tool_slug : "unknown";
      return {
        requireApproval: {
          title: `Composio: run ${slug}`.slice(0, 80),
          description:
            `Execute Composio tool ${slug} against connected account "${config.userId}".`.slice(
              0,
              256,
            ),
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
          timeoutBehavior: "deny",
        },
      };
    });
  },
});
