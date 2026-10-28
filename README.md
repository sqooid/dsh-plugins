# dsh-plugins

Plugins (bundles) for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), the DeepSeek Harness.

| Bundle | Description |
|---|---|
| [hindsight-memory](hindsight-memory/) | Long-term memory backed by a [Hindsight](https://github.com/vectorize-io/hindsight) server: recall, retain, and reflect tools plus automatic retention of completed turns. |
| [auto-effort](auto-effort/) | Automatic reasoning-effort selection: a small evaluator model picks one of the current model's real thinking levels per prompt when Effort is on Default; includes a CLIProxyAPI level sync script. |
| [llm-fallbacks-custom](llm-fallbacks-custom/) | Custom fallback-chain plugin for DSH `0.2.1-rc.2`, adapted from upstream for quota and rate-limit failover. Install from its local directory; not published on npm. |
| [searxng-search](searxng-search/) | `web_search` backed by a self-hosted [SearXNG](https://docs.searxng.org/) instance (JSON API) instead of the DeepSeek search API. |
| [no-token](no-token/) | Opening DSH web no longer needs the launch token: browsers on trusted hosts get the session cookie automatically. Only use it when something else controls access to the port. |

## Compatibility hotfixes

- [subagent-compat](subagent-compat/): tested local hotfix for DSH 0.2.1-alpha.4 subagent discovery and optional model selectors. This patches the installed DSH package; it is not an installable plugin bundle.

## Install

Clone this repo, then install a bundle directory into your DSH profile, for example by asking the agent to
install `/path/to/dsh-plugins/hindsight-memory` with the plugin manager (`install_bundle`).
