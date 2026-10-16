#!/usr/bin/env node
/**
 * Sync each model's `reasoningEfforts` in a dsh profile from CLIProxyAPI's own
 * model definitions, so dsh offers exactly the thinking levels cpa supports.
 *
 * Usage: CPA_MANAGEMENT_KEY=<secret> node sync-cpa-efforts.mjs [--profile web] [--provider cpa] [--dry-run]
 *
 * Mapping per cpa model definition:
 * - no `thinking` block            → `reasoningEfforts: false` (no Effort row)
 * - `thinking.levels`              → those levels
 * - budget only (`min`/`max`)      → low / medium / high (cpa maps named efforts onto the budget range)
 * - `thinking.zero_allowed: true`  → also `off`, but only if a live probe with
 *   `reasoning.effort: "none"` succeeds. Some adaptive-only models (e.g.
 *   claude-opus-5-5) report zero_allowed yet reject `thinking.type: disabled`,
 *   and declaring `off` makes pi-ai send "none" on Default too, which breaks every
 *   Default turn. The probe uses the provider's API key (its `apiKeyEnv`, from the
 *   environment or the dsh credential store).
 * Models cpa does not define are left unchanged and reported.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const BUDGET_LEVELS = ['low', 'medium', 'high']
const CHANNELS = ['claude', 'codex', 'gemini', 'gemini-cli', 'vertex', 'aistudio', 'antigravity', 'qwen', 'iflow', 'kimi']

function parseArgs(argv) {
  const args = { profile: 'web', provider: 'cpa', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--profile' || arg === '--provider') args[arg.slice(2)] = argv[(i += 1)]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** `yaml` ships with dsh; load it from the dsh install so this script needs no install of its own. */
function loadYaml() {
  const dshBin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  if (!dshBin) throw new Error('dsh is not on PATH')
  return createRequire(realpathSync(dshBin))('yaml')
}

function effortsFor(thinking, offWorks) {
  if (thinking === undefined || thinking === null) return false
  const offered = new Set(Array.isArray(thinking.levels) && thinking.levels.length > 0 ? thinking.levels : BUDGET_LEVELS)
  if (thinking.zero_allowed === true && offWorks) offered.add('off')
  const efforts = {}
  for (const level of THINKING_LEVELS) if (offered.has(level)) efforts[level] = level === 'off' ? null : level
  return efforts
}

/** The provider API key: its `apiKeyEnv` from the environment, else from the dsh credential store. */
function providerApiKey(YAML, provider, dshHome) {
  const envName = provider.get('apiKeyEnv')
  if (typeof envName !== 'string') return undefined
  if (process.env[envName]) return process.env[envName]
  try {
    return YAML.parse(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))?.refs?.[envName]
  } catch {
    return undefined
  }
}

/** Whether the model accepts thinking turned off, as pi-ai sends it (`reasoning.effort: "none"`). */
async function offAccepted(baseUrl, apiKey, model) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: 'Reply with OK.', max_output_tokens: 16, reasoning: { effort: 'none' } }),
  })
  await response.text()
  if (response.ok) return true
  if (response.status === 400) return false
  throw new Error(`probe ${model}: HTTP ${response.status}`)
}

async function fetchDefinitions(baseUrl, key) {
  const definitions = new Map()
  for (const channel of CHANNELS) {
    const response = await fetch(`${baseUrl}/v0/management/model-definitions/${channel}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    if (response.status === 400) continue // channel unknown to this cpa build
    if (!response.ok) throw new Error(`cpa ${channel}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    const { models = [] } = await response.json()
    for (const model of models) if (!definitions.has(model.id)) definitions.set(model.id, { channel, thinking: model.thinking })
  }
  return definitions
}

const args = parseArgs(process.argv.slice(2))
const key = process.env.CPA_MANAGEMENT_KEY
if (!key) throw new Error('set CPA_MANAGEMENT_KEY to the cpa remote-management secret')

const YAML = loadYaml()
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const patchPath = join(dshHome, 'profiles', args.profile, 'cordis.patch.yml')
const doc = YAML.parseDocument(readFileSync(patchPath, 'utf8'))
const entry = doc.contents.items.find((item) => item.get('id') === 'llm-pi-ai')
const provider = entry?.getIn(['config', 'providers', args.provider], true)
if (!provider) throw new Error(`${patchPath}: no llm-pi-ai provider "${args.provider}"`)

const baseUrl = String(provider.get('baseURL') ?? '').replace(/\/v1\/?$/, '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(baseUrl)) throw new Error(`provider "${args.provider}" has no http(s) baseURL`)
const definitions = await fetchDefinitions(baseUrl, key)
const apiKey = providerApiKey(YAML, provider, dshHome)
if (!apiKey) throw new Error(`no API key for provider "${args.provider}" (apiKeyEnv) to probe "off" support`)

let changed = 0
for (const model of provider.get('models').items) {
  const id = model.get('id')
  const definition = definitions.get(id)
  if (!definition) {
    console.log(`${id}: not defined by cpa, left unchanged`)
    continue
  }
  const offWorks = definition.thinking?.zero_allowed === true && (await offAccepted(baseUrl, apiKey, id))
  if (definition.thinking?.zero_allowed === true && !offWorks) console.log(`${id}: cpa reports zero_allowed but the model rejects thinking off; not offering "off"`)
  const next = effortsFor(definition.thinking, offWorks)
  const current = model.get('reasoningEfforts')
  const currentJson = JSON.stringify(YAML.isNode(current) ? current.toJSON() : current)
  const label = next === false ? 'false' : Object.keys(next).join(' ')
  if (currentJson === JSON.stringify(next)) {
    console.log(`${id}: ${label} (unchanged)`)
    continue
  }
  model.set('reasoningEfforts', doc.createNode(next))
  changed += 1
  console.log(`${id}: ${label}`)
}

if (args.dryRun) console.log(`dry run: ${changed} model(s) would change`)
else if (changed > 0) {
  writeFileSync(patchPath, doc.toString())
  console.log(`wrote ${changed} change(s) to ${patchPath}; restart dsh to apply`)
} else console.log('no changes')
