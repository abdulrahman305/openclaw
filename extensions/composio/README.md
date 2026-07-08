# @openclaw/composio

Expose an allowlisted set of [Composio](https://composio.dev) tools to the
OpenClaw agent, gated behind per-call approval.

The plugin registers two **optional** agent tools (users must opt in via
`tools.allow` before the model can see them):

- `composio_search` - find Composio tool slugs within the configured toolkit
  allowlist.
- `composio_execute` - execute a tool slug against the configured connected
  account. Restricted to the toolkit allowlist and gated by a
  `before_tool_call` approval prompt.

## Configuration

Set the plugin config in your Gateway config under the `composio` plugin entry:

```json5
{
  plugins: {
    composio: {
      // apiKey: "comp_...",       // or set COMPOSIO_API_KEY in the environment
      userId: "default", // Composio user id for the connected account
      allowedToolkits: ["github", "gmail"],
      searchLimit: 10,
      requireApproval: true, // per-call approval before composio_execute
    },
  },
}
```

| Key               | Default              | Purpose                                                        |
| ----------------- | -------------------- | -------------------------------------------------------------- |
| `apiKey`          | `COMPOSIO_API_KEY`   | Composio API key. Env var used when the config value is unset. |
| `userId`          | `default`            | Composio user id used to resolve the connected account.        |
| `allowedToolkits` | `["github","gmail"]` | Lowercase toolkit slugs. Tools outside this list are refused.  |
| `searchLimit`     | `10`                 | Max tools returned by `composio_search`.                       |
| `requireApproval` | `true`               | Require approval before each `composio_execute` call.          |

## Security

OpenClaw answers on shared channels and can auto-approve pairing. Composio tools
act on real connected accounts (email, source control), so this plugin is
deliberately conservative:

- Both tools are `optional`, so they are hidden until explicitly allowlisted.
- `composio_execute` refuses any tool whose toolkit is not in `allowedToolkits`,
  verified by resolving the tool server-side before execution.
- Every `composio_execute` call raises a per-call approval
  (`allow-once` / `deny`, deny-on-timeout) unless `requireApproval` is disabled.

Keep `allowedToolkits` as narrow as possible and leave `requireApproval` on.

## Build and validate

This is a bundled workspace plugin; it ships the TypeScript source entry
(`./index.ts`). From the OpenClaw repo root:

```bash
pnpm install
openclaw plugins validate --root extensions/composio --entry ./index.ts
```
