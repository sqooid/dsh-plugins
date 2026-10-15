# @local/dsh-hindsight-memory

Long-term memory for DSH agents, backed by a [Hindsight](https://github.com/vectorize-io/hindsight) server.

## What it adds

| Piece | Behavior |
|---|---|
| `hindsight_recall` tool | `POST /v1/default/banks/{bank}/memories/recall`; returns ranked facts with type, date, tags. Optional `tags` filter. |
| `hindsight_retain` tool | Async `POST /v1/default/banks/{bank}/memories`; tags with `project:<workspace dir>` automatically. |
| `hindsight_reflect` tool | `POST /v1/default/banks/{bank}/reflect`; a synthesized answer from memory. |
| System prompt section | Tells the model when to recall, retain, and reflect. |
| Auto-retain | After every *completed* top-level turn, the human prompt and final assistant text are appended (async) to a Hindsight document whose id is the DSH session id, context `dsh`, tag `project:<workspace dir>`. |

## Config (`cordis.patch.yml`, row id `hindsight-memory`)

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | `http://localhost:8888` | The Hindsight **data-plane** API. The Control Plane UI (e.g. `:9999`) shows it under `/api/health`. |
| `bankId` | `omp` | Memory bank to read and write. |
| `apiKey` | – | Sent as `Authorization: Bearer …` when set. |
| `autoRetain` | `true` | Retain completed turns automatically. |
| `retainSubagents` | `false` | Also retain turns of subagent sessions. |
| `retainContext` | `dsh` | Hindsight `context` for retained items. |
| `recallBudget` | `mid` | `low` / `mid` / `high`. |
| `recallMaxTokens` | `4096` | Default recall token budget. |
| `timeoutMs` | `120000` | Per-request timeout. |

Override in your profile patch, for example:

```yaml
- id: hindsight-memory
  name: '@local/dsh-hindsight-memory'
  config:
    baseUrl: http://localhost:8888
    bankId: dsh
    autoRetain: false
```

(An override replaces the whole `config`; missing keys fall back to the defaults above.)
