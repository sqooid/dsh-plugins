/**
 * Private recognition process for one Whisper model.
 *
 * Runs outside DSH's module resolution, so it imports only Node builtins and
 * loads sherpa-onnx-node from the absolute path the Host passes in.
 *
 * argv[2]: JSON { sherpa, encoder, decoder, tokens, vad, multilingual, threads,
 *                 segmentSeconds, vadThreshold, minSpeechSeconds,
 *                 minSilenceSeconds, vadOnsetPaddingSeconds, maxAudioBytes }
 * env DSH_SPEECH_TOKEN: 64-hex bearer secret (removed once read).
 *
 * After loading the models it listens on an ephemeral loopback port and prints
 * `{"port":N}\n` as its only stdout output. POST /transcribe?language=xx with a
 * 16 kHz mono PCM16 WAV body answers { text, segments, audioSeconds,
 * inferenceSeconds, language }.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

class InputError extends Error {}

/** Validate canonical 16 kHz mono PCM16 WAV and return its sample view. */
export function parseWave(audio, maxAudioBytes) {
  if (audio.byteLength > maxAudioBytes) throw new InputError('Speech audio exceeds the worker byte limit')
  if (audio.byteLength < 44) throw new InputError('Invalid speech WAV: too short')
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const tag = (offset) => String.fromCharCode(...audio.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') throw new InputError('Invalid speech WAV: not canonical RIFF/WAVE')
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const rate = view.getUint32(24, true)
  const bits = view.getUint16(34, true)
  if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) throw new InputError('Invalid speech WAV: expected 16 kHz mono PCM16')
  const length = view.getUint32(40, true)
  if (length + 44 > audio.byteLength || length % 2 !== 0) throw new InputError('Invalid speech WAV: inconsistent data length')
  const samples = new Float32Array(length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768
  return samples
}

function createTranscriber(config) {
  const sherpa = createRequire(import.meta.url)(config.sherpa)
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: config.encoder, decoder: config.decoder, language: config.multilingual ? '' : 'en', task: 'transcribe', tailPaddings: -1 },
      tokens: config.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: config.vadThreshold,
      minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds,
      maxSpeechDuration: config.segmentSeconds,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1)
  let configuredLanguage = nativeConfig.modelConfig.whisper.language

  return (audio, language) => {
    const samples = parseWave(audio, config.maxAudioBytes)
    const audioSeconds = samples.length / 16000
    // '' lets multilingual Whisper detect the language; English-only models ignore other hints.
    const wanted = config.multilingual ? (language === 'auto' ? '' : language) : 'en'
    if (wanted !== configuredLanguage) {
      nativeConfig.modelConfig.whisper.language = wanted
      recognizer.setConfig(nativeConfig)
      configuredLanguage = wanted
    }
    detector.reset()
    const started = performance.now()
    const segments = []
    let detected
    const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16000)
    const decode = (speech) => {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: speech })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      detected ??= result.lang || undefined
      const text = String(result.text ?? '').trim()
      if (text) segments.push(text)
    }
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false)
        // Whisper hears the start of a word poorly when VAD cuts it; restore a little onset.
        const from = Math.max(0, segment.start - onsetPadding)
        const to = Math.min(samples.length, segment.start + segment.samples.length + Math.round(0.2 * 16000))
        decode(samples.slice(from, to))
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush()
    drain()
    return {
      text: segments.join(' ').replace(/\s+/g, ' ').trim(),
      segments,
      language: detected,
      audioSeconds,
      inferenceSeconds: (performance.now() - started) / 1000,
    }
  }
}

async function startServer(token, maxAudioBytes, transcribe) {
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const reply = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume()
      return reply(401, { error: 'Unauthorized' })
    }
    const url = new URL(request.url, 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume()
      return reply(404, { error: 'Unknown endpoint' })
    }
    const length = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 44 || length > maxAudioBytes) {
      request.resume()
      return reply(413, { error: 'Invalid speech audio size', code: 'invalid-input' })
    }
    ;(async () => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get('language') ?? 'auto'))
      } catch (error) {
        reply(error instanceof InputError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof InputError ? { code: 'invalid-input' } : {}),
        })
      }
    })()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server.address().port
}

async function main() {
  const config = JSON.parse(process.argv[2])
  const token = process.env.DSH_SPEECH_TOKEN
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Missing worker token')
  delete process.env.DSH_SPEECH_TOKEN
  const port = await startServer(token, config.maxAudioBytes, createTranscriber(config))
  process.stdout.write(`${JSON.stringify({ port })}\n`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1))
  })
}
