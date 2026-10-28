/**
 * OpenWhispr-style post-processing of one recognized transcript.
 *
 * raw segments -> cleanTranscript -> replacements -> LLM cleanup (optional,
 * raw fallback on any failure) -> dictionary spelling -> snippets.
 */
import { randomUUID } from 'node:crypto'
import {
  applyReplacements,
  assertValidCleanupOutput,
  buildCleanupSystemPrompt,
  cleanTranscript,
  enforceDictionarySpelling,
  expandSnippets,
  isPlausibleCleanup,
  stripThinkingTags,
  stripWrappers,
  wrapCleanupTranscript,
} from './text.js'

/** Read every volatile setting once so one recording sees one consistent configuration. */
export function snapshotSettings(config) {
  const read = (value, fallback) => (value && typeof value.get === 'function' ? value.get() : value) ?? fallback
  return {
    cleanup: read(config.cleanup, true),
    cleanupProvider: read(config.cleanupProvider, ''),
    cleanupModel: read(config.cleanupModel, ''),
    cleanupPrompt: read(config.cleanupPrompt, ''),
    instructions: read(config.instructions, ''),
    agentName: read(config.agentName, ''),
    spelling: read(config.spelling, 'en-US'),
    dictionary: read(config.dictionary, []),
    replacements: read(config.replacements, []),
    snippets: read(config.snippets, []),
    cleanupTimeoutMs: config.cleanupTimeoutMs ?? 30000,
    cleanupMaxTokens: config.cleanupMaxTokens ?? 4096,
  }
}

/**
 * Call the configured cleanup model once.
 * @returns cleaned text; throws on failure, timeout, empty or implausible output.
 */
export async function runCleanup(llm, settings, text, language, signal) {
  const timeout = AbortSignal.timeout(settings.cleanupTimeoutMs)
  const callSignal = AbortSignal.any([signal, timeout])
  const system = buildCleanupSystemPrompt({
    template: settings.cleanupPrompt,
    agentName: settings.agentName,
    language,
    spelling: settings.spelling,
    instructions: settings.instructions,
    dictionary: settings.dictionary,
    replacements: settings.replacements,
    snippetTriggers: settings.snippets.map((snippet) => snippet?.trigger),
  })
  try {
    const call = await llm.prepareCall(
      { provider: settings.cleanupProvider, model: settings.cleanupModel, maxTokens: settings.cleanupMaxTokens },
      callSignal,
      (controls, model) => {
        // Cleanup must not think: pick the model's least effort, and temperature 0 when that effort is "off".
        const least = model.reasoning?.efforts?.[0]?.id
        if (least === undefined) return { ...controls, temperature: 0 }
        return /^(?:off|none|disabled)$/i.test(least) ? { ...controls, reasoningEffort: least, temperature: 0 } : { ...controls, reasoningEffort: least }
      },
    )
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: wrapCleanupTranscript(text) }],
      source: { kind: 'dsh-whisper-dictation' },
    }
    let output = ''
    for await (const chunk of call.stream({ ...call.config, messages: [message], system, signal: callSignal })) {
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure?.message ?? chunk.reason.kind)
        if (chunk.reason.kind === 'max-tokens') throw new Error('cleanup output was truncated')
      }
    }
    const cleaned = stripWrappers(stripThinkingTags(output), text)
    if (!settings.cleanupPrompt?.trim()) assertValidCleanupOutput(text, cleaned)
    if (!isPlausibleCleanup(text, cleaned)) throw new Error(`cleanup output does not look like a cleaned transcript (${cleaned.length} chars from ${text.length})`)
    return cleaned
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new Error(`cleanup timed out after ${settings.cleanupTimeoutMs} ms`)
    throw error
  }
}

/**
 * Full pipeline for one recognized recording.
 * @param segments - Whisper text per VAD segment.
 * @returns { text, raw, cleaned, cleanupMs, cleanupError }
 */
export async function postProcess({ llm, logger, settings, segments, language, signal }) {
  const raw = cleanTranscript(segments)
  let text = applyReplacements(raw, settings.replacements)
  let cleaned = false
  let cleanupError
  const started = performance.now()
  if (text && settings.cleanup && settings.cleanupProvider && settings.cleanupModel && llm) {
    try {
      text = await runCleanup(llm, settings, text, language, signal)
      cleaned = true
    } catch (error) {
      signal.throwIfAborted()
      cleanupError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`whisper-dictation: cleanup failed, keeping the raw transcript: ${cleanupError}`)
    }
  }
  const cleanupMs = performance.now() - started
  // Deterministic passes run after cleanup too, so the model can't undo them.
  text = applyReplacements(text, settings.replacements, { repeatSafeOnly: true })
  text = enforceDictionarySpelling(text, settings.dictionary)
  text = expandSnippets(text, settings.snippets)
  return { text: text.trim(), raw, cleaned, cleanupMs, cleanupError }
}
