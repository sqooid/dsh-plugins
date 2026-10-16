/**
 * Hindsight memory for DSH.
 *
 * - Tools: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`.
 * - A system-prompt section telling the model when to use them.
 * - Optional auto-retain: each completed top-level turn (human prompt + final
 *   assistant text) is appended to a Hindsight document keyed by the DSH session id.
 *
 * Dependency-free on purpose: it uses only Node's global `fetch`.
 */
import { basename } from 'node:path'

export const name = 'hindsight-memory'
export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  baseUrl: 'http://localhost:8888',
  bankId: 'omp',
  apiKey: undefined,
  autoRetain: true,
  retainSubagents: false,
  retainContext: 'dsh',
  recallBudget: 'mid',
  recallMaxTokens: 4096,
  timeoutMs: 120000,
}

const BUDGETS = ['low', 'mid', 'high']
const SECTION_ORDER = 3150 // just after MCP_SERVERS (3100)
const MAX_RETAIN_CHARS = 60000

function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '')
  if (!/^https?:\/\//.test(config.baseUrl)) throw new Error(`hindsight-memory: baseUrl must be an http(s) URL, got ${config.baseUrl}`)
  if (typeof config.bankId !== 'string' || config.bankId.length === 0) throw new Error('hindsight-memory: bankId must be a non-empty string')
  if (!BUDGETS.includes(config.recallBudget)) throw new Error(`hindsight-memory: recallBudget must be one of ${BUDGETS.join(', ')}`)
  for (const key of ['recallMaxTokens', 'timeoutMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`hindsight-memory: ${key} must be a positive integer`)
  }
  return config
}

/** Project tag used for every memory written from a session's working directory. */
function projectTag(cwd) {
  const dir = cwd ? basename(cwd) : ''
  return dir ? `project:${dir}` : undefined
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function formatDate(value) {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : undefined
}

function formatRecall(results) {
  if (!Array.isArray(results) || results.length === 0) return 'No relevant memories found.'
  return results
    .map((r, i) => {
      const date = formatDate(r.occurred_start) ?? formatDate(r.mentioned_at)
      const meta = [r.type, date, ...(Array.isArray(r.tags) ? r.tags : [])].filter(Boolean).join(', ')
      return `${i + 1}. ${r.text}${meta ? `  [${meta}]` : ''}`
    })
    .join('\n')
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function requireString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`\`${key}\` must be a non-empty string`)
  return value.trim()
}

function optionalTags(args) {
  const tags = args?.tags
  if (tags === undefined) return undefined
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.length === 0)) throw new Error('`tags` must be an array of non-empty strings')
  return tags.length > 0 ? tags : undefined
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const bankPath = `/v1/default/banks/${encodeURIComponent(config.bankId)}`
  const logger = ctx.logger?.('hindsight-memory') ?? console

  async function call(method, path, body, signal) {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    let response
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      if (timeout.aborted) throw new Error(`Hindsight request timed out after ${config.timeoutMs} ms (${method} ${path})`)
      throw new Error(`Cannot reach Hindsight at ${config.baseUrl}: ${error?.cause?.message ?? error?.message ?? error}`)
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`Hindsight ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Hindsight returned non-JSON for ${method} ${path}: ${text.slice(0, 200)}`)
    }
  }

  // ---- Tools -------------------------------------------------------------

  ctx.tools.register({
    name: 'hindsight_recall',
    description:
      'Search long-term memory (Hindsight) for facts, decisions, preferences, and past work relevant to a query. ' +
      'Use it at the start of non-trivial tasks, when the user refers to earlier work or conventions, or before asking the user something memory may already answer. ' +
      'Returns ranked memories with type, date, and tags.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Natural-language search query; be specific (names, projects, topics).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter, e.g. ["project:my-repo"]; matches memories with any of the tags. Omit to search everything.',
        },
        max_tokens: { type: 'integer', description: `Token budget for returned memories; defaults to ${config.recallMaxTokens}.` },
      },
      required: ['query'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Recall memories: ${args?.query ?? ''}`, kind: 'search' }),
    async execute(args, exec) {
      const query = requireString(args, 'query')
      const tags = optionalTags(args)
      const maxTokens = Number.isSafeInteger(args?.max_tokens) && args.max_tokens > 0 ? args.max_tokens : config.recallMaxTokens
      const body = { query, budget: config.recallBudget, max_tokens: maxTokens }
      if (tags) Object.assign(body, { tags, tags_match: 'any' })
      const result = await call('POST', `${bankPath}/memories/recall`, body, exec.signal)
      return { text: formatRecall(result.results) }
    },
  })

  ctx.tools.register({
    name: 'hindsight_retain',
    description:
      'Store information in long-term memory (Hindsight) so future sessions can recall it. ' +
      'ALWAYS call this when the user asks you to remember, note, save, or keep something in mind (e.g. "remember that …", "note that …", "from now on …"), ' +
      'and when the user corrects you or states a preference. Also use it for durable facts you discover: project conventions, decisions and their reasons, environment details, and lessons learned. ' +
      'Write self-contained statements with enough context (who, what, which project, why). Do not store secrets. ' +
      (config.autoRetain ? 'Background transcript retention is lossy and does not replace this tool: explicit requests to remember must still be stored here.' : ''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'The information to remember, as self-contained text.' },
        context: { type: 'string', description: 'Optional short label for the kind of content, e.g. "user preference" or "architecture decision".' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra tags. The current project tag ("project:<workspace dir>") is added automatically.',
        },
      },
      required: ['content'],
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Retain memory', kind: 'edit', rawInput: args }),
    async execute(args, exec) {
      const content = requireString(args, 'content')
      const tags = new Set(optionalTags(args) ?? [])
      const session = exec.agent?.session
      const project = projectTag(session?.header?.cwd)
      if (project) tags.add(project)
      const item = {
        content,
        timestamp: new Date().toISOString(),
        context: typeof args.context === 'string' && args.context.trim() ? args.context.trim() : config.retainContext,
        tags: [...tags],
      }
      if (session?.id) item.metadata = { session_id: String(session.id) }
      const result = await call('POST', `${bankPath}/memories`, { items: [item], async: true }, exec.signal)
      const op = result.operation_id ? ` (operation ${result.operation_id})` : ''
      return { text: `Queued for memory in bank "${config.bankId}"${op}. Facts are extracted in the background.` }
    },
  })

  ctx.tools.register({
    name: 'hindsight_reflect',
    description:
      'Ask long-term memory (Hindsight) to reason over everything it knows and answer a question, e.g. "What are this user\'s coding preferences?" or ' +
      '"What do we know about the deployment setup of project X?". Slower than hindsight_recall; use it for synthesized answers rather than raw facts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The question to answer from memory.' },
        context: { type: 'string', description: 'Optional extra context about why you are asking.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter, e.g. ["project:my-repo"].' },
      },
      required: ['query'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Reflect on memory: ${args?.query ?? ''}`, kind: 'search' }),
    async execute(args, exec) {
      const body = { query: requireString(args, 'query'), budget: 'low' }
      if (typeof args.context === 'string' && args.context.trim()) body.context = args.context.trim()
      const tags = optionalTags(args)
      if (tags) Object.assign(body, { tags, tags_match: 'any' })
      const result = await call('POST', `${bankPath}/reflect`, body, exec.signal)
      return { text: typeof result.text === 'string' && result.text.trim() ? result.text : 'Memory had nothing to say about this.' }
    },
  })

  // ---- Prompt guidance ---------------------------------------------------

  ctx.systemPrompt.section({
    name: 'hindsight-memory',
    order: SECTION_ORDER,
    interpolate: false,
    text:
      '# Long-term memory\n\n' +
      'You have persistent memory across sessions through the Hindsight tools. ' +
      'When the user asks you to remember, note, or keep something in mind ("remember that …", "from now on …"), or corrects you or states a preference, ' +
      'call `hindsight_retain` in that same turn with a self-contained statement of it, then confirm briefly. Never just acknowledge such a request without storing it. ' +
      'Call `hindsight_recall` before starting non-trivial work, and whenever the user mentions earlier work, preferences, or conventions; ' +
      'pass a specific query, and add a `project:<workspace dir>` tag only when you want results limited to this project. ' +
      'Treat recalled memories as possibly outdated hints and verify them against the workspace before relying on them. ' +
      'Use `hindsight_retain` for durable facts worth stating explicitly (preferences, decisions and their reasons, conventions); never retain secrets. ' +
      'Use `hindsight_reflect` when you need a synthesized answer rather than individual facts.',
  })

  // ---- Auto-retain -------------------------------------------------------

  if (!config.autoRetain) return

  /** Collect the human prompt(s) and the final assistant text of the turn closed at `endSeq`. */
  function collectTurn(session, endSeq, turn) {
    const prompts = []
    let answer = ''
    for (let seq = endSeq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (!event) continue
      if (event.type === 'turn/start' && event.data.turn === turn) break
      if (event.type === 'assistant/message' && !answer && !event.data.interrupted) {
        answer = textOf(event.data.message?.content)
      } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        const text = textOf(event.data.content)
        if (text) prompts.unshift(text)
      }
    }
    return { prompts, answer }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return
    const header = session.header ?? {}
    if (!config.retainSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return
    let turnText
    try {
      const { prompts, answer } = collectTurn(session, event.seq, event.data.turn)
      if (prompts.length === 0 || !answer) return // goal rounds, injected-only turns, tool-only endings
      turnText = `User: ${prompts.join('\n\n')}\n\nAssistant: ${answer}`
    } catch (error) {
      logger.warn?.('hindsight-memory: cannot read turn for retention: %s', error?.message ?? error)
      return
    }
    if (turnText.length > MAX_RETAIN_CHARS) turnText = `${turnText.slice(0, MAX_RETAIN_CHARS)}\n[truncated]`
    const sessionId = String(session.id ?? header.id)
    const project = projectTag(header.cwd)
    const item = {
      content: turnText,
      timestamp: new Date(event.time ?? Date.now()).toISOString(),
      context: config.retainContext,
      document_id: sessionId,
      update_mode: 'append',
      metadata: { session_id: sessionId },
      ...(project ? { tags: [project] } : {}),
    }
    call('POST', `${bankPath}/memories`, { items: [item], async: true }).catch((error) => {
      logger.warn?.('hindsight-memory: auto-retain failed: %s', error?.message ?? error)
    })
  })
}
