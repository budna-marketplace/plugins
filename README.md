# Budna

Find and compare new and pre-owned items.

Discover new and pre-owned items on Budna that fit your needs and budget. Compare options, check condition and compatibility, and plan pickup or delivery before you decide.

The plugin connects to Budna’s public, read-only marketplace MCP server and bundles six Recommerce skills for comparison, complete kits, inspection, collection planning, keep-or-replace decisions, and reassessment. No account, API key, local server, or runtime dependencies are required for the default connection.

The plugin compares and explains options. It cannot bid, buy, reserve items, or contact sellers. Prices, availability, contents, and condition need current evidence; a recommendation is not a reservation or an inspection.

## Install

From this checkout, use a current Claude Code release:

```sh
claude plugin marketplace add .
claude plugin install budna@budna-marketplace
```

Or use Codex:

```sh
codex plugin marketplace add .
codex plugin add budna@budna-marketplace
```

Start a new session after installation. To install from GitHub, replace `.` in the marketplace command with `budna-marketplace/plugins`.

In Claude web or desktop, add this repository as a marketplace from **Customize → Plugins → Add → Add marketplace**. Add the bundled connector from the plugin’s **Connectors** tab. A repository marketplace is separate from a reviewed public directory listing.

Install Budna in Codex from this repository or the universal `budna-vX.Y.Z.zip` release bundle. The `budna-vX.Y.Z-openai.zip` asset is for ChatGPT plugin import: its explicit no-auth metadata is not accepted by Codex CLI 0.164.0’s strict Agent Plugins MCP parser. The repository and universal bundle keep the portable MCP configuration and connect to the same public endpoint without credentials.

## Clients and distribution

Claude and Codex package validation, Gemini CLI installation and MCP connection, and Copilot CLI installation have been checked. Other clients still need installation and live task testing. Public listings require a separate submission or catalog review.

| Client | Package or connection | Public distribution |
| --- | --- | --- |
| Claude | Claude plugin and marketplace manifests; install above. | Submit the connector and plugin through [Claude’s developer portal](https://claude.ai/directory/manage). |
| Codex | Codex compatibility manifest; install above. | Submit the endpoint and skills together through [With MCP](https://developers.openai.com/plugins/guides/submit-claude-plugin#submit-a-plugin-with-a-remote-mcp-server). |
| Gemini CLI | [gemini-extension.json](gemini-extension.json) and the shared skills; `gemini extensions install .`. | Follow the [extension release and gallery instructions](https://geminicli.com/docs/extensions/releasing/). |
| Gemini app and Search | The public MCP endpoint; this is separate from Gemini CLI. | Apply for the [Connected Apps preview](https://developers.google.com/connected-apps), then configure, test, and submit in Connected Console. |
| Cursor | Root [plugin.json](plugin.json), [mcp.json](mcp.json), and skills use the supported [Agent Plugins format](https://cursor.com/docs/reference/plugins). | Use the shared [Grok Bot and Cursor submission form](https://x.ai/bot/marketplace/submit-a-plugin). |
| GitHub Copilot CLI | The same portable package; `copilot plugin install .` is a documented [local install](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference). | Propose an [external plugin entry](https://github.com/github/awesome-copilot/blob/main/CONTRIBUTING.md#adding-external-plugins). |
| Grok Build | Its [plugin guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md) accepts Claude-compatible manifests. | Submit a pinned source commit to the [official plugin catalog](https://github.com/xai-org/plugin-marketplace/blob/main/CONTRIBUTING.md). |
| Grok Bot | Submit the public MCP URL or repository; in-app testing is required. | Use the shared [Grok Bot and Cursor form](https://x.ai/bot/marketplace/submit-a-plugin). |
| Grok | Add the public endpoint through [Connectors → New Connector → Custom](https://docs.x.ai/grok/connectors). | The shared submission form still labels Grok marketplace distribution “coming soon.” |
| Cline | Use the public MCP endpoint and install the skills separately; this bundle has not been tested as a Cline plugin. | Propose separate MCP and skill entries through the [Cline catalog](https://github.com/cline/marketplace/blob/main/CONTRIBUTING.md). |
| Perplexity Computer | Import this public repository or upload the portable ZIP, then confirm all six skills and the Budna connector appear. | [Custom plugin import](https://www.perplexity.ai/help-center/en/articles/2026100802-create-or-upload-a-custom-plugin) supports personal and organization distribution. A public catalog submission route has not been verified. |

## Use

- “Find a complete used cordless drill delivered to Gothenburg for under 1,000 SEK.”
- “Compare these listings by fit, delivered cost, and decisive unknowns.”
- “Prepare an inspection checklist for this second-hand listing.”

| Skill | Purpose |
| --- | --- |
| [Buy](skills/recommerce-buy/SKILL.md) | Find and compare suitable listings. |
| [Kits](skills/recommerce-kits/SKILL.md) | Assemble a complete, compatible setup within one budget. |
| [Inspect](skills/recommerce-inspect/SKILL.md) | Prepare checks for a specific used item. |
| [Collect](skills/recommerce-collect/SKILL.md) | Assess transport, access, and collection costs. |
| [Keep](skills/recommerce-keep/SKILL.md) | Compare keeping or repairing with replacing. |
| [Second Look](skills/recommerce-second-look/SKILL.md) | Recheck a prior recommendation against new evidence. |

## MCP connection

The MCP configurations point to `https://api.budna.se/mcp`: [.mcp.json](.mcp.json) for Claude and Codex compatibility, [mcp.json](mcp.json) for Agent Plugins, and [gemini-extension.json](gemini-extension.json) for Gemini CLI. The connection exposes public marketplace data and interactive listing cards where the client supports MCP Apps. Other clients receive the text and structured-data output. The server is maintained separately in [budna-marketplace/mcp](https://github.com/budna-marketplace/mcp).

Personal account access is optional and is not enabled by this package. Follow [Budna’s account connection instructions](https://github.com/budna-marketplace/mcp#connect-your-budna-account) to connect `https://api.budna.se/account/mcp` through OAuth. That resource also includes the public tools; use one Budna connection in a session to avoid duplicate tools. Each client signs in separately and the user chooses the account permissions.

## Maintain

The six skill folders are unchanged copies of [Recommerce](https://github.com/budna-marketplace/recommerce) at commit [`ebb44ab9629148beb9763a3517a6bd860a11a7e4`](https://github.com/budna-marketplace/recommerce/tree/ebb44ab9629148beb9763a3517a6bd860a11a7e4/skills), including their references and MIT licenses. Keep upstream as the source of truth: update complete folders from an explicitly selected commit, inspect the changes, and update this provenance when refreshing the bundle. The installed bundle contains regular files; no submodules or build step are required.

The client manifests share the same plugin name, version, skills, and public MCP endpoint. Keep every versioned manifest aligned for a release. Validate with a current Claude Code release:

```sh
claude plugin validate --strict --profile directory .
```

Also verify each client discovers the package and all six skills, and test a real supplied-listing task in each client. The installed skills and remote connection require no hooks or executable runtime dependencies.

## Releases

Run the local checks before releasing with Python 3 and Node.js 24.12 or later. The TypeScript tests use Node’s built-in test runner and require no npm dependencies:

```sh
python3 scripts/release.py check
node --test tests/release.test.mts
```

Use immutable `vMAJOR.MINOR.PATCH` tags. The numeric version must match `plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `gemini-extension.json`. Merge the versioned source to `main`, then create and push a fresh tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The Release workflow validates the tag and main ancestry, runs the tests, and creates a draft GitHub release containing the universal ZIP and `SHA256SUMS`. Inspect the draft, then publish it from GitHub or a user-authenticated GitHub CLI:

```sh
gh release edit v0.1.0 --draft=false
```

Publishing the draft starts six jobs gated by the `claude`, `openai`, `gemini`, `cursor`, `copilot`, and `grok` GitHub environments. Each environment requires `mjovanc` to review and permits only `v*` tags, matching the MCP repository’s release gates. Self-review is allowed. There are no provider credentials in the bundle or environment configuration.

After approval, each job verifies the original release assets against the tagged source and exports its platform ZIP and checksum. Existing assets are never overwritten: a retry must match the original bytes. Release-tag updates and deletions are blocked by the repository’s Release tags ruleset. Keep GitHub’s release-asset immutability setting off for this flow because platform assets are attached after publication; the workflow enforces byte consistency itself.

The GitHub release exposes installable bundles. It does not approve or publish a provider directory listing. Complete the relevant portal submission, gallery indexing, or upstream catalog review from the table above. The tested extension has the repository topic `gemini-cli-extension`, which makes it eligible for Gemini CLI’s daily gallery indexing.

Public listings require their own connection tests, listing assets, and review; pushing this repository does not publish a listing.

[Privacy policy](https://legal.budna.se/privacy-policy) · [MIT](LICENSE) · [Budna](https://budna.se)
