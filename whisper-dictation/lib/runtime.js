/**
 * Verified model files for one Whisper size, and the managed recognition
 * worker that loads them. Mirrors the shipped SenseVoice provider's contract:
 * activation only inspects disk; downloads happen on explicit preparation; the
 * worker wakes on the first recording and sleeps after idleTimeoutMs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const LOCK = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'))
export const WORKER = fileURLToPath(new URL('../worker.js', import.meta.url))

/** Languages Whisper recognizes well enough to offer as hints (plus auto-detect). */
export const MULTILINGUAL = ['auto', 'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'cy', 'sk', 'fa', 'lv', 'bn', 'sr', 'sl', 'et', 'tl', 'yue']

export function isMultilingual(size) {
  return LOCK.models[size]?.languages === 'multi'
}

export function modelBytes(size) {
  const model = LOCK.models[size]
  return model.encoder.bytes + model.decoder.bytes + model.tokens.bytes
}

/** Locate sherpa-onnx-node in the DSH installation (the worker runs outside DSH's resolver). */
export function resolveSherpa(explicit) {
  if (explicit) return explicit
  const attempts = [
    () => createRequire(realpathSync(process.argv[1])).resolve('sherpa-onnx-node'),
    () => createRequire(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'))).resolve('sherpa-onnx-node'),
    () => fileURLToPath(import.meta.resolve('sherpa-onnx-node')),
    () => createRequire(import.meta.url).resolve('sherpa-onnx-node'),
  ]
  const failures = []
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch (error) {
      failures.push(error?.message ?? String(error))
    }
  }
  throw new Error(`sherpa-onnx-node was not found in the DSH installation; set sherpaPath. (${failures.join('; ')})`)
}

/** Public download failure, shaped like SpeechDownloadFailure. */
export class DownloadError extends Error {
  constructor(download, options) {
    super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}${download.status ? ` (HTTP ${download.status})` : ''}${download.code ? ` (${download.code})` : ''}`, options)
    this.download = download
  }
}

function classify(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    const code = current.code
    if (current.name === 'TimeoutError') return { reason: 'timeout' }
    if (typeof code === 'string') {
      if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return { reason: 'dns', code }
      if (/TIMEOUT|ETIMEDOUT/.test(code)) return { reason: 'timeout', code }
      if (/CERT|TLS|SELF_SIGNED/.test(code)) return { reason: 'certificate', code }
      if (/^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/.test(code)) return { reason: 'storage', code }
      if (/^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code)) return { reason: 'network', code }
    }
  }
  return { reason: error instanceof TypeError ? 'network' : 'unknown' }
}

async function sha256File(path, signal) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
  return digest.digest('hex')
}

/**
 * Is the file present and verified? A `.verified` marker written after a hashed
 * download avoids re-hashing gigabytes at every activation; a file without a
 * marker (placed by hand) is hashed once.
 */
export async function isVerified(path, asset, signal) {
  signal?.throwIfAborted()
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size !== asset.bytes) return false
  try {
    const marker = JSON.parse(await readFile(`${path}.verified`, 'utf8'))
    if (marker.sha256 === asset.sha256 && marker.bytes === asset.bytes && marker.mtimeMs === info.mtimeMs) return true
  } catch {}
  if ((await sha256File(path, signal)) !== asset.sha256) return false
  await writeFile(`${path}.verified`, JSON.stringify({ sha256: asset.sha256, bytes: asset.bytes, mtimeMs: info.mtimeMs }))
  return true
}

/** Download one pinned asset from the first working origin, hashing as it streams. */
export async function download(asset, directory, origins, signal, report) {
  const destination = join(directory, asset.name)
  if (await isVerified(destination, asset, signal)) return destination
  await mkdir(directory, { recursive: true })
  const path = new URL(asset.url).pathname
  let lastError
  for (const [index, origin] of origins.entries()) {
    const url = new URL(path, origin).href
    const source = new URL(origin).origin
    const partial = `${destination}.${randomUUID()}.part`
    try {
      const response = await fetch(url, { signal })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new DownloadError({ resource: asset.name, source, reason: 'http', status: response.status })
      }
      const digest = createHash('sha256')
      let completedBytes = 0
      report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes })
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          completedBytes += chunk.length
          if (completedBytes > asset.bytes) return callback(new DownloadError({ resource: asset.name, source, reason: 'integrity' }))
          digest.update(chunk)
          report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes })
          callback(null, chunk)
        },
      })
      await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
      if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) throw new DownloadError({ resource: asset.name, source, reason: 'integrity' })
      await rename(partial, destination)
      const info = await stat(destination)
      await writeFile(`${destination}.verified`, JSON.stringify({ sha256: asset.sha256, bytes: asset.bytes, mtimeMs: info.mtimeMs }))
      return destination
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error instanceof DownloadError ? error : new DownloadError({ resource: asset.name, source, ...classify(error) }, { cause: error })
      if (lastError.download.reason === 'storage' || index === origins.length - 1) throw lastError
    } finally {
      await rm(partial, { force: true })
    }
  }
  throw lastError
}

/** Paths of one size's model files and the VAD under dataRoot. */
export function modelPaths(config, size) {
  const model = LOCK.models[size]
  const directory = join(config.dataRoot, 'models', size)
  return {
    directory,
    encoder: join(directory, model.encoder.name),
    decoder: join(directory, model.decoder.name),
    tokens: join(directory, model.tokens.name),
    vadDirectory: join(config.dataRoot, 'models', 'silero'),
    vad: config.vadModelPath ?? join(config.dataRoot, 'models', 'silero', LOCK.vad.name),
  }
}

export async function inspectModel(config, size, signal) {
  const model = LOCK.models[size]
  const paths = modelPaths(config, size)
  const checks = [[paths.encoder, model.encoder], [paths.decoder, model.decoder], [paths.tokens, model.tokens]]
  if (config.vadModelPath === undefined) checks.push([paths.vad, LOCK.vad])
  for (const [path, asset] of checks) if (!(await isVerified(path, asset, signal))) return undefined
  if (config.vadModelPath !== undefined) await stat(config.vadModelPath)
  return paths
}

export async function prepareModel(config, size, signal, report) {
  const model = LOCK.models[size]
  const paths = modelPaths(config, size)
  const origins = config.modelOrigins
  report({ phase: 'checking', step: 'model', startedAt: Date.now() })
  for (const asset of [model.encoder, model.decoder, model.tokens]) {
    await download(asset, paths.directory, origins, signal, (state) => report({ ...state, step: 'model' }))
  }
  if (config.vadModelPath === undefined) {
    report({ phase: 'checking', step: 'vad', startedAt: Date.now() })
    await download(LOCK.vad, paths.vadDirectory, origins, signal, (state) => report({ ...state, step: 'vad' }))
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  const verified = await inspectModel(config, size, signal)
  if (!verified) throw new Error(`Whisper ${size} verification failed: missing or corrupted model files`)
  return verified
}

/** Wait for a promise but give up when the signal aborts. */
function waitFor(pending, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Speech operation cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function readReady(handle, limit, signal) {
  const stdout = handle.stdout
  if (!stdout) throw new Error('Whisper worker stdout is unavailable')
  let text = ''
  const pending = Promise.withResolvers()
  const data = (chunk) => {
    text += chunk.toString('utf8')
    if (text.length > limit) return pending.reject(new Error('Whisper worker readiness exceeded its byte limit'))
    const end = text.indexOf('\n')
    if (end < 0) return
    try {
      const port = JSON.parse(text.slice(0, end)).port
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`)
      pending.resolve(port)
    } catch (error) {
      pending.reject(new Error('Invalid Whisper worker readiness', { cause: error }))
    }
  }
  stdout.on('data', data)
  stdout.on('error', pending.reject)
  handle.done.then(() => pending.reject(new Error(`Whisper worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text ?? ''}`)), pending.reject)
  try {
    return await waitFor(pending.promise, signal)
  } finally {
    stdout.off('data', data)
    stdout.off('error', pending.reject)
    stdout.resume()
  }
}

/** A recording the worker rejected before inference; the worker stays loaded. */
export class SpeechInputError extends Error {}

/**
 * One Whisper size: Host-owned preparation state (SpeechPreparation) plus a
 * serial queue in front of a lazily started recognition process.
 */
export class WhisperModel {
  tail = Promise.resolve()
  pending = 0
  lifetime = new AbortController()
  listeners = new Set()
  lastProgressAt = 0
  worker
  paths
  preparing
  idle

  constructor(ctx, config, size, sherpa) {
    this.ctx = ctx
    this.config = config
    this.size = size
    this.sherpa = sherpa
    this.downloadSources = [...new Set(config.modelOrigins.map((origin) => new URL(origin).origin))]
    const kinds = ['check', 'model', ...(config.vadModelPath === undefined ? ['vad'] : []), 'verify', 'load']
    this.state = { phase: 'unprepared', steps: kinds.map((kind) => ({ kind, status: 'pending' })) }
  }

  snapshot() {
    return this.state
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(state) {
    if (this.preparing && ['ready', 'standby', 'unprepared', 'failed', 'cancelled'].includes(state.phase)) this.preparing.completed = true
    const previous = this.state
    const steps = state.steps ?? previous.steps.map((item) => {
      if (state.phase === 'ready') return { ...item, status: 'complete' }
      if (state.step === 'check' && item.kind !== 'check') return { kind: item.kind, status: 'pending' }
      if (state.step === item.kind) return item.status === 'running' ? item : { kind: item.kind, status: 'running', startedAt: Date.now() }
      if (item.status !== 'running') return item
      if (state.phase === 'standby') return { ...item, status: 'cancelled' }
      if (state.phase === 'failed' || state.phase === 'cancelled') return { ...item, status: state.phase }
      return state.step === undefined ? item : { ...item, status: 'complete' }
    })
    this.state = { ...state, steps }
    const now = performance.now()
    if (state.phase === 'downloading' && previous.phase === 'downloading' && state.resource === previous.resource && state.completedBytes !== state.totalBytes && now - this.lastProgressAt < this.config.progressIntervalMs) return
    this.lastProgressAt = now
    for (const listener of this.listeners) listener()
  }

  /** Activation: verify caches without downloading or loading anything. */
  inspect() {
    this.runPreparation(async (signal) => {
      const inspection = AbortSignal.any([signal, AbortSignal.timeout(this.config.prepareTimeoutMs)])
      this.publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
      const paths = await inspectModel(this.config, this.size, inspection)
      inspection.throwIfAborted()
      this.paths = paths
      this.publish({
        phase: paths ? 'standby' : 'unprepared',
        steps: this.state.steps.map(({ kind }) => ({ kind, status: kind === 'check' || (paths && kind !== 'load') ? 'complete' : 'pending' })),
      })
    })
  }

  prepare(options = {}) {
    const source = options.downloadSource
    if (source !== undefined && !this.downloadSources.includes(source)) throw new Error('Speech download source is unavailable')
    const config = source === undefined ? this.config : { ...this.config, modelOrigins: [source] }
    if (this.preparing?.kind === 'inspect') {
      // Activation's cache check is still running; prepare once it settles.
      this.preparing.settled.then(() => {
        if (!this.worker && !this.lifetime.signal.aborted && this.state.phase !== 'cancelled') this.prepare(options)
      })
      return
    }
    this.runPreparation(async (signal) => {
      await this.start(signal, config)
    }, source, 'prepare')
  }

  runPreparation(run, downloadSource, kind = 'inspect') {
    if (this.preparing && this.preparing.kind === 'prepare' && this.preparing.downloadSource !== downloadSource) throw new Error('Cancel preparation before changing its download source')
    if (this.preparing || this.worker) return
    this.lifetime.signal.throwIfAborted()
    const abort = new AbortController()
    const task = { abort, settled: Promise.resolve(), completed: false, downloadSource, kind }
    this.preparing = task
    task.settled = this.enqueue(run, abort.signal)
      .catch((error) => {
        if (this.lifetime.signal.aborted) return
        this.publish(abort.signal.aborted
          ? { phase: 'cancelled' }
          : { phase: 'failed', message: error instanceof Error ? error.message : String(error), ...(error instanceof DownloadError ? { download: error.download } : {}) })
      })
      .finally(() => {
        this.preparing = undefined
      })
  }

  async cancel() {
    const task = this.preparing
    if (!task) return
    if (!task.completed) {
      this.publish({ phase: 'cancelling', startedAt: Date.now() })
      task.abort.abort(new Error('Speech preparation cancelled'))
    }
    await task.settled
  }

  /** @returns the worker's raw result { text, segments, language, audioSeconds, inferenceSeconds }. */
  async recognize(input, signal) {
    return await this.enqueue(async (combined) => await this.execute(input, combined), signal)
  }

  async enqueue(run, signal) {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (this.pending >= this.config.maxPending) throw new Error('Speech transcription queue is full')
    clearTimeout(this.idle)
    this.pending++
    const job = this.tail.then(async () => {
      combined.throwIfAborted()
      return await run(combined)
    })
    this.tail = job.then(() => undefined, () => undefined).finally(() => {
      this.pending--
      if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
        this.idle = setTimeout(() => {
          this.tail = this.tail.then(async () => await this.stop())
          this.tail.catch((error) => this.ctx.logger?.warn?.('Whisper worker idle cleanup failed', error))
        }, this.config.idleTimeoutMs)
      }
    })
    return await job
  }

  async start(signal, preparationConfig = this.config) {
    if (this.worker?.closed) await this.stop()
    if (this.worker) return this.worker
    const setup = AbortSignal.any([signal, AbortSignal.timeout(this.config.prepareTimeoutMs)])
    const cached = this.paths !== undefined
    if (!cached) this.publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
    const paths = this.paths ?? await prepareModel(preparationConfig, this.size, setup, (state) => this.publish(state))
    this.paths = paths
    setup.throwIfAborted()
    this.publish({ phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() })
    await mkdir(this.config.dataRoot, { recursive: true })
    const token = randomBytes(32).toString('hex')
    const workerConfig = {
      sherpa: this.sherpa,
      encoder: paths.encoder,
      decoder: paths.decoder,
      tokens: paths.tokens,
      vad: paths.vad,
      multilingual: isMultilingual(this.size),
      threads: this.config.threads,
      segmentSeconds: this.config.segmentSeconds,
      vadThreshold: this.config.vadThreshold,
      minSpeechSeconds: this.config.minSpeechSeconds,
      minSilenceSeconds: this.config.minSilenceSeconds,
      vadOnsetPaddingSeconds: this.config.vadOnsetPaddingSeconds,
      maxAudioBytes: this.config.maxAudioBytes,
    }
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, WORKER, JSON.stringify(workerConfig)],
      cwd: this.config.dataRoot,
      graceMs: this.config.graceMs,
      env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.config.maxLogBytes } },
    })
    try {
      const port = await readReady(handle, this.config.maxLogBytes, setup)
      const worker = { handle, url: `http://127.0.0.1:${port}`, token, closed: false }
      this.worker = worker
      this.publish({ phase: 'ready' })
      const exited = () => {
        if (!worker.closed) {
          worker.closed = true
          this.publish({ phase: 'standby' })
        }
      }
      handle.done.then(exited, exited)
      return worker
    } catch (error) {
      handle.terminate()
      await handle.waitForExit()
      throw error
    }
  }

  async execute(input, signal) {
    const phase = this.state.phase
    if (phase !== 'ready' && phase !== 'standby') throw new Error(`Prepare Whisper ${this.size} before recording (Plugins → Voice input → Download and prepare)`)
    try {
      const worker = await this.start(signal)
      const call = AbortSignal.any([signal, AbortSignal.timeout(this.config.inferenceTimeoutMs)])
      const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'audio/wav' },
        body: Buffer.from(input.audio),
        signal: call,
      })
      const text = await response.text()
      if (text.length > this.config.maxResponseBytes) throw new Error('Whisper transcript exceeded its byte limit')
      const value = JSON.parse(text)
      if (!response.ok) {
        if (value.code === 'invalid-input') throw new SpeechInputError(value.error)
        throw new Error(value.error ?? `Whisper worker HTTP ${response.status}`)
      }
      return value
    } catch (error) {
      if (error instanceof SpeechInputError) throw error
      await this.stop()
      this.publish({ phase: 'standby' })
      throw error
    }
  }

  async stop() {
    const worker = this.worker
    if (!worker) return
    worker.closed = true
    worker.handle.terminate()
    await worker.handle.waitForExit()
    this.worker = undefined
    this.publish({ phase: 'standby' })
  }

  async dispose() {
    this.listeners.clear()
    this.lifetime.abort(new Error('Whisper provider disposed'))
    clearTimeout(this.idle)
    try {
      await this.tail
    } finally {
      await this.stop()
    }
    await this.preparing?.settled
  }
}
