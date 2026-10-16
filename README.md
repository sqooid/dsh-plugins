# dsh-plugins

Plugins (bundles) for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), the DeepSeek Harness.

| Bundle | Description |
|---|---|
| [hindsight-memory](hindsight-memory/) | Long-term memory backed by a [Hindsight](https://github.com/vectorize-io/hindsight) server: recall, retain, and reflect tools plus automatic retention of completed turns. |
| [auto-effort](auto-effort/) | Automatic reasoning-effort selection: a small evaluator model picks one of the current model's real thinking levels per prompt when Effort is on Default; includes a CLIProxyAPI level sync script. |

## Compatibility hotfixes

- [subagent-compat](subagent-compat/): tested local hotfix for DSH 0.2.1-alpha.4 subagent discovery and optional model selectors. This patches the installed DSH package; it is not an installable plugin bundle.

## Install

Clone this repo, then install a bundle directory into your DSH profile, for example by asking the agent to
install `/path/to/dsh-plugins/hindsight-memory` with the plugin manager (`install_bundle`).
