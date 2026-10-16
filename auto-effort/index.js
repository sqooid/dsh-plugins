/**
 * Auto effort for DSH.
 *
 * When the model picker's Effort is left on Default, a small evaluator model
 * reads the human prompt that opened the turn and picks one of the reasoning
 * levels the session's current model actually offers
 * (`llm.resolveModelInfo(...).reasoning.efforts`). The level is applied to every
 * request of that turn. An explicit Effort choice is never overridden, and any
 * evaluator failure leaves the request on Default.
 *
 * The evaluator route (`provider`/`model`) is volatile: Settings → Plugins →
 * Auto effort edits it live, without remounting the plugin.
 *
 * Only dependency: the runtime's schemastery, resolved as a peer.
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'auto-effort'
export const inject = ['llm']

export const Config = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().min(1).default('cpa').volatile(),
  model: z.string().min(1).default('claude-haiku-4-5-20251001').volatile(),
  excludeLevels: z.array(z.string()).default([]),
  maxPromptChars: z.number().step(1).min(1).default(6000),
  maxOutputTokens: z.number().step(1).min(1).default(64),
  timeoutMs: z.number().step(1).min(1).default(10000),
})

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
}

function systemPrompt(levels) {
  return [
    'You choose how much extended reasoning an AI coding agent should spend on a user request.',
    `Options, from least to most reasoning: ${levels.join(', ')}.`,
    'Pick the lowest option that will still produce a correct, high-quality result.',
    'Lowest options: greetings, chit-chat, trivial questions, simple mechanical requests (run a command, rename, small lookups).',
    'Middle options: routine coding, explanations, single-file changes, straightforward investigations.',
    'Highest options: hard debugging with unclear cause, multi-step design or refactors across many files, complex algorithms, concurrency, security- or correctness-critical analysis.',
    'Reply with exactly one option id from the list and nothing else.',
  ].join('\n')
}

/**
 * Return the allowed level the evaluator named, or undefined when its answer
 * names none or several. Some models wrap the id (`{"option": "low"}`, `**low**`),
 * so any answer naming exactly one option as a whole word counts.
 */
function parseLevel(text, levels) {
  const answer = text.toLowerCase()
  const named = levels.filter((level) => new RegExp(`(^|[^a-z0-9_])${level}([^a-z0-9_]|$)`).test(answer))
  return named.length === 1 ? named[0] : undefined
}

export function apply(ctx, config) {
  if (!config.enabled) return
  const logger = ctx.logger?.('auto-effort') ?? console
  const excluded = new Set(config.excludeLevels)
  /** Human prompt text admitted for each agent's open turn. */
  const prompts = new WeakMap()
  /** Level chosen for each agent's open turn (`undefined` = stay on Default). */
  const decisions = new WeakMap()
  /** Latest `model/selection` payload per session id (`null` = never selected). */
  const selections = new Map()

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'model/selection') selections.set(String(session.id), event.data)
  })

  /**
   * The Effort the user picked, or undefined for Default. dsh copies the last
   * request's effort into later requests and the composer caption, so the
   * request config cannot tell a picked level from one this plugin applied;
   * the picker's own `model/selection` events can.
   */
  function pickedEffort(session) {
    const id = String(session.id)
    if (!selections.has(id)) {
      // Restored session: its earlier events never published here; scan once.
      let latest = null
      for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(seq)
        if (event?.type === 'model/selection') {
          latest = event.data
          break
        }
      }
      selections.set(id, latest)
    }
    return selections.get(id)?.reasoningEffort
  }

  async function evaluate(prompt, levels, signal) {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const callSignal = AbortSignal.any([signal, timeout])
    const call = await ctx.llm.prepareCall(
      { provider: config.provider.get(), model: config.model.get(), maxTokens: config.maxOutputTokens },
      callSignal,
      (controls, model) => {
        // The evaluator itself should not think: use its least effort.
        const least = model.reasoning?.efforts[0]?.id
        return least === undefined ? controls : { ...controls, reasoningEffort: least }
      },
    )
    const clipped = prompt.length > config.maxPromptChars ? `${prompt.slice(0, config.maxPromptChars)}\n[truncated]` : prompt
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `Choose the option for this request (JSON string):\n${JSON.stringify(clipped)}` }],
      source: { kind: 'dsh-auto-effort' },
    }
    let text = ''
    try {
      for await (const chunk of call.stream({ ...call.config, messages: [message], system: systemPrompt(levels), signal: callSignal })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          throw new Error(chunk.reason.failure?.message ?? chunk.reason.kind)
        }
      }
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error(`evaluator timed out after ${config.timeoutMs} ms`)
      throw error
    }
    const level = parseLevel(text, levels)
    if (level === undefined) throw new Error(`evaluator answered ${JSON.stringify(text.slice(0, 80))}, not one of ${levels.join(', ')}`)
    return level
  }

  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const text = decision.messages
      .filter((message) => message?.source?.kind === 'user')
      .map((message) => textOf(message.content))
      .filter((part) => part.trim().length > 0)
      .join('\n\n')
    if (text) prompts.set(agent, { turn, text })
    return decision
  })

  ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
    const resolved = await next()
    if (!resolved.provider || !resolved.model || pickedEffort(agent.session) !== undefined) return resolved
    // Effort is on Default: drop any effort inherited from an earlier request.
    const { reasoningEffort: _inherited, ...base } = resolved
    const cached = decisions.get(agent)
    if (cached?.turn === turn) return cached.level === undefined ? base : { ...base, reasoningEffort: cached.level }
    const prompt = prompts.get(agent)
    if (prompt?.turn !== turn) return resolved // no human prompt opened this turn (subagent, goal round, …)

    let level
    const started = Date.now()
    try {
      const info = await ctx.llm.resolveModelInfo(base.provider, base.model, signal)
      const levels = (info.reasoning?.efforts ?? []).map((effort) => effort.id).filter((id) => !excluded.has(id))
      if (levels.length >= 2) {
        level = await evaluate(prompt.text, levels, signal)
        logger.info?.(`auto-effort: turn ${turn} ${base.provider}/${base.model} -> ${level} (of ${levels.join(', ')}; ${Date.now() - started} ms)`)
      }
    } catch (error) {
      if (signal.aborted) throw error
      logger.warn?.(`auto-effort: keeping Default for turn ${turn}: ${error?.message ?? error}`)
    }
    decisions.set(agent, { turn, level })
    return level === undefined ? base : { ...base, reasoningEffort: level }
  }, { prepend: true })
}
