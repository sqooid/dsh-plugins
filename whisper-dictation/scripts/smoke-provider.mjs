#!/usr/bin/env node
/**
 * Exercise lib/runtime.js WhisperModel end to end outside DSH: inspect,
 * prepare (download + verify from a local mirror or Hugging Face), spawn the
 * worker through a minimal ctx.subprocess, transcribe, idle, dispose.
 *
 *   node scripts/smoke-provider.mjs <dataRoot> <size> <file.wav>
 *
 * Files already present in <dataRoot>/models/<size>/ are verified, not downloaded.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { WhisperModel, resolveSherpa } from '../lib/runtime.js'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const [dataRoot, size, wav] = process.argv.slice(2)
const dshRoot = join(process.execPath, '../../lib/node_modules/@deepseek-ai/dsh')
const sherpa = resolveSherpa(createRequire(join(dshRoot, 'package.json')).resolve('sherpa-onnx-node'))

const subprocess = {
  spawn({ argv, cwd, env, stdio }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })))
    return {
      stdout: child.stdout,
      collected: { stderr: { readFrom: () => ({ text: stderr }) } },
      done,
      terminate: () => child.kill(),
      waitForExit: async () => { await done; return true },
    }
  },
}

const config = {
  dataRoot, modelOrigins: ['https://huggingface.co'], vadModelPath: undefined, threads: 4, segmentSeconds: 28,
  vadThreshold: 0.5, minSpeechSeconds: 0.25, minSilenceSeconds: 0.8, vadOnsetPaddingSeconds: 0.3,
  maxAudioBytes: 32 * 1024 * 1024, prepareTimeoutMs: 3_600_000, inferenceTimeoutMs: 300_000, idleTimeoutMs: 2000,
  maxPending: 4, graceMs: 1000, maxLogBytes: 65536, maxResponseBytes: 1 << 20, progressIntervalMs: 1000,
}
const model = new WhisperModel({ subprocess, logger: console }, config, size, sherpa)
const phases = []
model.subscribe(() => {
  const s = model.snapshot()
  const label = s.phase === 'downloading' ? `downloading ${s.resource} ${Math.round(100 * s.completedBytes / s.totalBytes)}%` : s.phase
  if (phases.at(-1) !== label) { phases.push(label); console.log('state:', label, s.steps.map((x) => `${x.kind}:${x.status}`).join(' ')) }
})
const settle = async (wanted) => { while (!wanted.includes(model.snapshot().phase)) await new Promise((r) => setTimeout(r, 100)) }
model.inspect()
if (process.env.PREPARE_DURING_INSPECT) model.prepare()
else await model.preparing?.settled
if (model.snapshot().phase !== 'standby') {
  model.prepare()
  await settle(['ready', 'failed'])
  if (model.snapshot().phase === 'failed') throw new Error(model.snapshot().message)
}
const audio = new Uint8Array(await readFile(wav))
for (let i = 0; i < 2; i++) {
  const started = performance.now()
  const result = await model.recognize({ audio, language: 'auto' }, new AbortController().signal)
  console.log(`run ${i}: ${((performance.now() - started) / 1000).toFixed(2)} s`, JSON.stringify(result.text))
}
await new Promise((r) => setTimeout(r, 3000))
console.log('after idle:', model.snapshot().phase)
await model.dispose()
console.log('disposed')
