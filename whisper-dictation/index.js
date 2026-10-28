/**
 * Whisper dictation for DSH — OpenWhispr's pipeline as a speech provider.
 *
 * Registers one local Whisper provider per configured model size
 * (`whisper-<size>`) with DSH's experimental speech-to-text service, so the
 * shipped Voice Input microphone, recording toolbar and Download-and-prepare
 * cards drive it. Each recording runs:
 *
 *   sherpa-onnx Whisper (+ Silero VAD segmentation) in a managed worker
 *   -> blank-marker / silence-hallucination filtering
 *   -> your replacement rules
 *   -> LLM cleanup with OpenWhispr's prompt + your dictionary (raw fallback)
 *   -> exact dictionary spellings, snippet expansion
 *
 * The cleanup/dictionary fields are volatile: Plugins → Dictation edits them
 * live, without a restart.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { postProcess, snapshotSettings } from './lib/cleanup.js'
import { LOCK, MULTILINGUAL, WhisperModel, isMultilingual, modelBytes, resolveSherpa } from './lib/runtime.js'

export const name = 'whisper-dictation'
export const inject = ['speechToText', 'subprocess', 'llm']

const SIZES = Object.keys(LOCK.models)
const origin = z.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/)
const Rule = z.object({ from: z.string(), to: z.string() })
const Snippet = z.object({ trigger: z.string(), replacement: z.string() })

export const Config = z.object({
  // --- recognition (restart to apply) ---
  dataRoot: z.string().min(1).required().description('Absolute model cache directory.'),
  models: z.array(z.union(SIZES)).min(1).default(['base.en', 'small.en', 'medium.en', 'turbo']).description('Whisper sizes offered as recognizers (one provider each).'),
  providerPrefix: z.string().min(1).default('whisper-'),
  sherpaPath: z.union([z.string().min(1), z.const(undefined)]).description('Override the sherpa-onnx-node entry file.'),
  vadModelPath: z.union([z.string().min(1), z.const(undefined)]),
  modelOrigins: z.array(origin).min(1).default(['https://huggingface.co', 'https://hf-mirror.com']),
  threads: z.natural().min(1).default(4),
  segmentSeconds: z.number().min(1).max(30).default(28),
  vadThreshold: z.number().min(0).max(1).default(0.5),
  minSpeechSeconds: z.number().min(0).default(0.25),
  minSilenceSeconds: z.number().min(0.01).default(0.8),
  vadOnsetPaddingSeconds: z.number().min(0).max(1).default(0.3),
  maxAudioBytes: z.natural().min(46).default(32 * 1024 * 1024),
  prepareTimeoutMs: z.natural().min(1).default(3_600_000),
  inferenceTimeoutMs: z.natural().min(1).default(300_000),
  idleTimeoutMs: z.natural().default(900_000),
  maxPending: z.natural().min(1).default(4),
  graceMs: z.natural().min(1).default(1000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
  maxResponseBytes: z.natural().min(1).default(1024 * 1024),
  progressIntervalMs: z.natural().min(1).default(100),

  // --- cleanup and dictionary (live) ---
  cleanup: z.boolean().default(true).volatile(),
  cleanupProvider: z.string().default('cpa').volatile(),
  cleanupModel: z.string().default('claude-haiku-5-5').volatile(),
  cleanupPrompt: z.string().default('').volatile().description('Replaces the OpenWhispr cleanup prompt when non-empty; {{agentName}} is substituted.'),
  instructions: z.string().default('').volatile().description('Extra cleanup instructions appended after the language rule.'),
  agentName: z.string().default('').volatile(),
  spelling: z.union(['en-US', 'en-GB']).default('en-US').volatile(),
  dictionary: z.array(z.string()).default([]).volatile(),
  replacements: z.array(Rule).default([]).volatile(),
  snippets: z.array(Snippet).default([]).volatile(),
  cleanupTimeoutMs: z.natural().min(1).default(30_000),
  cleanupMaxTokens: z.natural().min(16).default(4096),
  historyLimit: z.natural().default(20).description('Recent dictations (raw and final text) kept in <dataRoot>/history.jsonl; 0 keeps none.'),
})

function megabytes(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

function tenthGigabytes(bytes) {
  return Math.ceil(bytes / 1e8) * 1e8
}

function round(seconds) {
  return Math.round(seconds * 100) / 100
}

/** The last `limit` dictations (raw vs final text), like OpenWhispr's local history. */
class History {
  tail = Promise.resolve()

  constructor(path, limit, logger) {
    this.path = path
    this.limit = limit
    this.logger = logger
  }

  add(entry) {
    if (this.limit === 0) return
    this.tail = this.tail.then(async () => {
      let lines = []
      try {
        lines = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      lines.push(JSON.stringify(entry))
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, `${lines.slice(-this.limit).join('\n')}\n`, { mode: 0o600 })
    }).catch((error) => this.logger.warn(`history write failed: ${error.message}`))
  }
}

export function apply(ctx, config) {
  for (const path of [config.dataRoot, config.vadModelPath, config.sherpaPath]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`whisper-dictation paths must be absolute: ${path}`)
  }
  // Product profiles mount no console exporter for ctx.logger; timings and
  // cleanup failures (never transcript text) go to the service log instead.
  const logger = {
    info: (message) => console.log(`[whisper-dictation] ${message}`),
    warn: (message) => console.warn(`[whisper-dictation] ${message}`),
  }
  const sherpa = resolveSherpa(config.sherpaPath)
  const history = new History(join(config.dataRoot, 'history.jsonl'), config.historyLimit, logger)

  for (const size of [...new Set(config.models)]) {
    const model = new WhisperModel(ctx, config, size, sherpa)
    const bytes = modelBytes(size)
    ctx.effect(() => {
      const unregister = ctx.speechToText.register({
        info: {
          id: `${config.providerPrefix}${size}`,
          name: `Whisper ${LOCK.models[size].label} · ${megabytes(bytes)}`,
          location: 'host-local',
          // English-only models also accept 'auto' (it means English) so switching
          // providers never fails on a saved auto-detect language.
          languages: isMultilingual(size) ? MULTILINGUAL : ['auto', 'en'],
          downloadSources: model.downloadSources,
          // The Voice input card prints bytes / 1e9 verbatim: keep to 0.1 GB steps.
          setupEstimate: {
            recommendedDiskBytes: tenthGigabytes(bytes * 1.1),
            expectedMemoryBytes: tenthGigabytes(bytes * 2.2 + 3e8),
            minimumMinutes: 1,
            maximumMinutes: Math.max(3, Math.ceil(bytes / 2e8)),
          },
        },
        preparation: model,
        transcribe: async (input, signal) => {
          const started = performance.now()
          const result = await model.recognize(input, signal)
          const settings = snapshotSettings(config)
          const language = input.language === 'auto' ? (result.language || 'auto') : input.language
          const processed = await postProcess({ llm: ctx.llm, logger, settings, segments: result.segments ?? [result.text], language, signal })
          const cleanup = processed.cleaned ? `${settings.cleanupModel} ${Math.round(processed.cleanupMs)} ms` : processed.cleanupError ? 'failed (raw kept)' : 'off'
          logger.info(`${size}: ${result.audioSeconds.toFixed(1)} s audio, whisper ${result.inferenceSeconds.toFixed(2)} s, cleanup ${cleanup}`)
          history.add({
            at: new Date().toISOString(),
            model: size,
            language: result.language,
            audioSeconds: round(result.audioSeconds),
            whisperSeconds: round(result.inferenceSeconds),
            cleanupModel: processed.cleaned ? `${settings.cleanupProvider}/${settings.cleanupModel}` : null,
            cleanupSeconds: processed.cleaned ? round(processed.cleanupMs / 1000) : null,
            cleanupError: processed.cleanupError ?? null,
            raw: processed.raw,
            text: processed.text,
          })
          return { text: processed.text, audioSeconds: result.audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
        },
      })
      model.inspect()
      return async () => {
        const removing = unregister()
        await model.dispose()
        await removing
      }
    }, `whisper-dictation: ${size}`)
  }
}
