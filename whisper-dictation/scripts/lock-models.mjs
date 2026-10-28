#!/usr/bin/env node
/**
 * Regenerate models.json: revision-pinned sherpa-onnx Whisper int8 exports on
 * Hugging Face, with exact byte sizes and SHA-256 digests.
 *
 *   node scripts/lock-models.mjs [size ...]
 *
 * LFS files carry their SHA-256 in the tree listing; small git files
 * (tokens.txt) are downloaded and hashed.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SIZES = {
  'tiny.en': { label: 'Tiny (English)', languages: 'en' },
  tiny: { label: 'Tiny', languages: 'multi' },
  'base.en': { label: 'Base (English)', languages: 'en' },
  base: { label: 'Base', languages: 'multi' },
  'small.en': { label: 'Small (English)', languages: 'en' },
  small: { label: 'Small', languages: 'multi' },
  'distil-small.en': { label: 'Distil Small (English)', languages: 'en' },
  'medium.en': { label: 'Medium (English)', languages: 'en' },
  medium: { label: 'Medium', languages: 'multi' },
  'distil-medium.en': { label: 'Distil Medium (English)', languages: 'en' },
  turbo: { label: 'Large v3 Turbo', languages: 'multi' },
  'distil-large-v3': { label: 'Distil Large v3 (English)', languages: 'en' },
  'large-v3': { label: 'Large v3', languages: 'multi' },
}

const HF = 'https://huggingface.co'
const VAD = {
  name: 'silero_vad.onnx',
  url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  bytes: 1807522,
  sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
}

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return await response.json()
}

async function hashUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function lock(size) {
  const repo = `csukuangfj/sherpa-onnx-whisper-${size}`
  const { sha } = await json(`${HF}/api/models/${repo}`)
  const tree = await json(`${HF}/api/models/${repo}/tree/${sha}`)
  const asset = async (name) => {
    const entry = tree.find((item) => item.path === name)
    if (!entry) throw new Error(`${repo}@${sha} has no ${name}`)
    const url = `${HF}/${repo}/resolve/${sha}/${name}`
    if (entry.lfs) return { name, url, bytes: entry.lfs.size, sha256: entry.lfs.oid }
    return { name, url, ...(await hashUrl(url)) }
  }
  return {
    ...SIZES[size],
    encoder: await asset(`${size}-encoder.int8.onnx`),
    decoder: await asset(`${size}-decoder.int8.onnx`),
    tokens: await asset(`${size}-tokens.txt`),
  }
}

const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SIZES)
const models = {}
for (const size of wanted) {
  if (!SIZES[size]) throw new Error(`Unknown size ${size}; known: ${Object.keys(SIZES).join(', ')}`)
  models[size] = await lock(size)
  const total = models[size].encoder.bytes + models[size].decoder.bytes + models[size].tokens.bytes
  console.log(`${size}: ${(total / 1e6).toFixed(0)} MB`)
}
const target = fileURLToPath(new URL('../models.json', import.meta.url))
await writeFile(target, `${JSON.stringify({ models, vad: VAD }, null, 2)}\n`)
console.log(`wrote ${target}`)
