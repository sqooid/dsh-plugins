#!/usr/bin/env node
/**
 * Smoke-test worker.js outside DSH: load one model, transcribe WAV files.
 *
 *   node scripts/smoke-worker.mjs <modelDir> <size> <vad.onnx> <file.wav> [...]
 *
 * <modelDir> holds <size>-encoder.int8.onnx, <size>-decoder.int8.onnx and
 * <size>-tokens.txt. WAVs must be 16 kHz mono PCM16; non-canonical headers are
 * rewritten to the canonical 44-byte form the browser sends.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const [modelDir, size, vad, ...wavs] = process.argv.slice(2)
if (!wavs.length) throw new Error('usage: smoke-worker.mjs <modelDir> <size> <vad.onnx> <file.wav> [...]')

const dshRoot = join(process.execPath, '../../lib/node_modules/@deepseek-ai/dsh')
const sherpa = createRequire(join(dshRoot, 'package.json')).resolve('sherpa-onnx-node')

function canonical(file) {
  const data = Buffer.from(file)
  let offset = 12
  let fmt
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    if (id === 'fmt ') fmt = data.subarray(offset + 8, offset + 8 + size)
    if (id === 'data') {
      if (!fmt || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 16000 || fmt.readUInt16LE(14) !== 16) throw new Error('need 16 kHz mono PCM16')
      const pcm = data.subarray(offset + 8, offset + 8 + size)
      const out = Buffer.alloc(44 + pcm.length)
      out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length, 4); out.write('WAVE', 8); out.write('fmt ', 12)
      out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24)
      out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36)
      out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44)
      return out
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

const token = randomBytes(32).toString('hex')
const config = {
  sherpa,
  encoder: join(modelDir, `${size}-encoder.int8.onnx`),
  decoder: join(modelDir, `${size}-decoder.int8.onnx`),
  tokens: join(modelDir, `${size}-tokens.txt`),
  vad,
  multilingual: !size.endsWith('.en') && size !== 'distil-large-v3',
  threads: 4,
  segmentSeconds: 28,
  vadThreshold: 0.5,
  minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.5,
  vadOnsetPaddingSeconds: 0.3,
  maxAudioBytes: 64 * 1024 * 1024,
}
const loadStarted = performance.now()
const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.js', import.meta.url)), JSON.stringify(config)], {
  env: { ...process.env, DSH_SPEECH_TOKEN: token },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const port = await new Promise((resolve, reject) => {
  let text = ''
  child.stdout.on('data', (chunk) => {
    text += chunk
    if (text.includes('\n')) resolve(JSON.parse(text).port)
  })
  child.on('exit', (code) => reject(new Error(`worker exited ${code}`)))
})
console.log(`loaded ${size} in ${((performance.now() - loadStarted) / 1000).toFixed(2)} s`)
try {
  for (const wav of wavs) {
    const body = canonical(await readFile(wav))
    const started = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/transcribe?language=${process.env.LANG_HINT ?? "auto"}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
      body,
    })
    const result = await response.json()
    console.log(wav, response.status, `${((performance.now() - started) / 1000).toFixed(2)} s`, JSON.stringify(result))
  }
} finally {
  child.kill()
}
