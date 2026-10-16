# auto-effort

Automatic reasoning-effort selection for DSH. When the model picker's **Effort** is on **Default**, a small evaluator model reads the human prompt that opened the turn and picks one of the levels the session's current model actually offers. The level applies to every request in that turn.

- **Levels are the model's own.** They come from `llm.resolveModelInfo(provider, model).reasoning.efforts`, minus `excludeLevels`. The evaluator's answer must name exactly one of them (wrappers such as `{"option": "low"}` are accepted), or the turn stays on Default.
- **A picked Effort wins.** Choosing any level in the picker turns the evaluator off for that session until you set it back to Default.
- **Failures are safe.** A timeout, an unreachable evaluator or an invalid answer is logged as a warning and the turn stays on Default.
- **Only human prompts are scored.** Turns without a human prompt (goal rounds, subagents) are left unchanged.

After a turn, the composer caption and each `request/header` in the session log show the level that was used.

## Choosing the evaluator model

Open **Plugins → Auto effort**, pick a model from **Evaluator model** (every model in the host's catalog, grouped by provider) and **Save**. The choice is written to the profile's `cordis.patch.yml` and applies from the next turn without a restart. A saved model that is no longer in the catalog stays listed as *currently unavailable*. Pick a fast text model: an image-only or failing evaluator just leaves every turn on Default.

## Configuration

`provider` and `model` are live settings (the card above edits them); the rest need a dsh restart.

```yaml
- id: auto-effort
  name: '@local/dsh-auto-effort'
  config:
    provider: cpa                         # evaluator route
    model: claude-haiku-4-5-20251001      # called with its least effort
    excludeLevels: []                     # e.g. [max] to cap cost
    maxPromptChars: 6000                  # longer prompts are truncated for scoring
    maxOutputTokens: 64
    timeoutMs: 10000
    enabled: true
```

## Syncing levels from CLIProxyAPI

dsh only knows the levels declared under `reasoningEfforts` in the profile. `sync-cpa-efforts.mjs` replaces them with what CLIProxyAPI reports per model (`/v0/management/model-definitions/<channel>`):

```sh
CPA_MANAGEMENT_KEY=<remote-management secret> node sync-cpa-efforts.mjs [--profile web] [--provider cpa] [--dry-run]
systemctl --user restart dsh-web
```

| cpa `thinking` | `reasoningEfforts` |
|---|---|
| absent (image models, non-reasoning models) | `false` (no Effort row) |
| `levels: [...]` | those levels |
| budget only (`min`/`max`) | `low`, `medium`, `high` |
| `zero_allowed: true` | adds `off`, only if a live request with `reasoning.effort: "none"` succeeds |

The probe matters because pi-ai sends `reasoning.effort: "none"` on **Default** too whenever a model declares `off`. Some adaptive-only Claude models (claude-opus-5-5, claude-sonnet-5-5, claude-fable-5, claude-fable-5-1) report `zero_allowed` but reject disabled thinking with HTTP 400, so declaring `off` for them breaks every Default turn. The probe uses the provider's API key from its `apiKeyEnv` (environment first, then the dsh credential store).

Models cpa does not define are left unchanged. Run the sync again after cpa's model list changes.
