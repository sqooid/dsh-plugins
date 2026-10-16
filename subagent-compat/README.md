# Subagent optional-selection compatibility hotfix

DSH 0.2.1-alpha.4 describes child LLM selectors as optional, but some model-facing
schema paths present every key as required. Agents then send empty strings,
which DSH rejects before discovery or delegation can run.

This narrowly scoped installed-package hotfix:

- advertises optional provider/model/reasoning selectors as string-or-null;
- treats null and empty string as omission for those selectors;
- lets `list_subagent_models` discover permitted providers without knowing one;
- preserves explicit route pairing, preflight validation and the session allowlist;
- includes allowed routes in delegation route-denial messages.

It does **not** change your allowed models or redirect a nonempty invalid route.
Pure inheritance follows DSH's existing behavior (its allowlist applies to explicit
model-facing selections). Missing required task fields remain errors.

## Test and apply

From the repository root:

```sh
node --test subagent-compat/patch.test.mjs
node subagent-compat/patch.mjs         # compatibility check; does not write
node subagent-compat/patch.mjs --apply
systemctl --user restart dsh-web
```

The default target is this machine's globally installed DSH package. Pass
`--target=/absolute/path/to/dsh-tool-subagent/lib/index.js` for another installation.
The patch checks expected source shapes, refuses unexpected targets, is
idempotent, and saves the original as `index.js.subagent-compat-v1.bak` alongside
the installed module. To undo, restore that backup to `index.js` and restart DSH.
Do not restore an old backup after upgrading to a different DSH version.

**DSH upgrades can replace this hotfix.** After an upgrade, rerun the tests and
compatibility check before reapplying; the script intentionally fails closed
when the implementation has changed. This is a local compatibility fix, not an
upstream release or an automatically installed plugin.

The tests import the real installed DSH implementation with the patch applied
in memory, register the actual tools against fake runtime services, and exercise
schema generation, discovery, spawn/fork request creation, route defaults,
explicit efforts and allowlist rejection. They make no model requests and do not
start real child agents.
