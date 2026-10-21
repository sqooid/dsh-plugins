> **Custom workspace copy:** this checkout is `llm-fallbacks-custom/` in `sqooid/dsh-plugins`, package and profile dependency name `@local/dsh-llm-fallbacks-custom`; its runtime bundle row remains `llm-fallbacks`. It is not the upstream npm package. Peers are pinned to DSH `0.2.1-rc.2`; re-check compatibility before using another DSH version.

## Prerequisites

- Build with Node ≥22 and pnpm ≥10.
- Peer packages are externalized to the DSH runtime. The package’s compiler/test dependency tree may not exactly match the runtime’s internal package table.

## Install local bundle

From the plugin directory:

```sh
pnpm install
dsh plugin --profile web add .
# Instead, use --profile dsh-tui to install in the terminal profile.
```

The package name, profile alias, and settings-card key are `@local/dsh-llm-fallbacks-custom`; the Cordis bundle row id remains `llm-fallbacks`. Bundle order places it after `@deepseek-ai/dsh-base` and its `llm-retry` handler. Restart dsh after installing.

Verify composition:

```sh
dsh --profile web --dump-config
```

The output should include the `llm-fallbacks` row after the built-in layers. The card appears under **Settings → Plugins → Fallbacks**; no model switching occurs until a chain is configured.

## Update or remove

After source changes, run `pnpm build` and restart dsh. To remove it:

```sh
dsh plugin --profile web remove @local/dsh-llm-fallbacks-custom
```

Restart dsh and check the composed config to confirm the `llm-fallbacks` row is gone.
