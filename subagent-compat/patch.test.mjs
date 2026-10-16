import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { defaultTarget, patchSource } from './patch.mjs'

const require = createRequire(defaultTarget)
const original = fs.readFileSync(defaultTarget, 'utf8')
const patched = patchSource(original)
// Load the real installed implementation with the proposed patch, resolving
// its imports from its original package. No installed files are modified.
const loadable = patched.replace(/from "([^".][^"]*)"/g, (_, spec) => `from "${pathToFileURL(require.resolve(spec)).href}"`)
const mod = await import(`data:text/javascript;base64,${Buffer.from(loadable).toString('base64')}`)
const routes = [{ provider: 'cpa', model: 'claude-opus-5-5' }, { provider: 'cpa', model: 'gpt-5.6-luna' }]

async function harness({ inherited = false, enabled = true, defaults } = {}) {
  const tools = new Map(), starts = [], preflights = []
  const backend = { name: 'test', inheritsParentContext: inherited, capabilities: { agentOptions: true, depthLimit: true } }
  const llm = {
    listProviders: () => [{ id: 'cpa', name: 'CPA' }, { id: 'other', name: 'Other' }],
    listModels: async () => [{ id: 'claude-opus-5-5', name: 'Opus' }, { id: 'gpt-5.6-luna', name: 'Luna' }, { id: 'hidden', name: 'Hidden' }],
    resolveModelInfo: async (_, model) => ({ id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
    resolveCallConfig: async request => { preflights.push(request) },
  }
  const ctx = {
    on() {}, effect(fn) { return fn() },
    get(name) { return { llm, subagentModelSelection: { current: () => ({ enabled, allowedModels: routes }) } }[name] },
    sessionProjections: { register() {}, stateOf: () => enabled ? routes : undefined },
    subagents: {
      getProvider: () => backend, resolveMaxDepth: () => undefined,
      startActivation: async request => { starts.push(request); return { childId: 'test-child' } },
    },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    systemPrompt: { section() {}, context() {}, getSectionOrder() {}, getContextOrder() {} },
  }
  const session = { firstLiveSeq: 0, eventAt() {}, header: {}, append() {} }
  await mod.apply(ctx, { provider: 'test', modelSelectionSettings: enabled, agentOptions: defaults }, session)
  const exec = { agent: { session: { requestHeader() {} }, options: { provider: 'cpa', model: 'parent-model', reasoningEffort: 'high' } }, signal: new AbortController().signal }
  return { tools, starts, preflights, exec }
}

const base = { description: 'Test child', prompt: 'Reply OK' }
const jsonArgs = value => JSON.parse(JSON.stringify(value))

test('patch is idempotent and fails closed on an unsupported build', () => {
  assert.equal(patchSource(patched), patched)
  assert.throws(() => patchSource('unrecognized source'), /Unsupported DSH build/)
})

for (const value of [undefined, null, '']) {
  test(`discovery accepts ${String(value)} placeholders and only exposes allowed routes`, async () => {
    const h = await harness(), discovery = h.tools.get('list_subagent_models')
    assert.equal(await discovery.execute(jsonArgs({ provider: value, model: value }), h.exec), 'cpa — CPA')
    const models = await discovery.execute(jsonArgs({ provider: 'cpa', model: value }), h.exec)
    assert.match(models, /cpa\/claude-opus-5-5/)
    assert.match(models, /cpa\/gpt-5.6-luna/)
    assert.doesNotMatch(models, /hidden/)
  })
  for (const inherited of [false, true]) {
    test(`${inherited ? 'fork' : 'spawn'} inherits with ${String(value)} selectors`, async () => {
      const h = await harness({ inherited }), tool = h.tools.get('subagent')
      const result = await tool.execute(jsonArgs({ ...base, provider: value, model: value, reasoning_effort: value }), h.exec)
      assert.equal(result.subagentId, 'test-child')
      assert.equal(h.starts.length, 1)
      assert.equal(h.starts[0].request.agentOptions, undefined)
      assert.equal(h.preflights.length, 0)
    })
  }
}

test('schemas advertise nullable selectors without requiring them', async () => {
  const h = await harness()
  for (const name of ['subagent', 'list_subagent_models']) {
    const schema = h.tools.get(name).parameters
    for (const field of ['provider', 'model', ...(name === 'subagent' ? ['reasoning_effort'] : [])]) {
      assert.deepEqual(schema.properties[field].oneOf, [{ type: 'string' }, { type: 'null' }])
      assert.ok(!schema.required?.includes(field))
    }
  }
})

test('real tool argument validation rejects non-string/non-null selectors', async () => {
  const h = await harness()
  for (const name of ['subagent', 'list_subagent_models']) {
    const tool = h.tools.get(name)
    const fields = ['provider', 'model', ...(name === 'subagent' ? ['reasoning_effort'] : [])]
    for (const field of fields) {
      await assert.rejects(tool.execute({ ...(name === 'subagent' ? base : {}), [field]: 42 }, h.exec), /invalid arguments/)
    }
  }
  await assert.rejects(h.tools.get('subagent').execute({ provider: null, model: null }, h.exec), /missing required/)
  assert.equal(h.starts.length, 0)
})

test('actual Responses conversion retains optional nullable selectors on the wire', async () => {
  const { convertResponsesTools } = await import(new URL('../../../@earendil-works/pi-ai/dist/api/openai-responses-shared.js', pathToFileURL(defaultTarget)))
  const h = await harness()
  const definitions = [...h.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  const wire = convertResponsesTools(definitions)
  for (const tool of wire) {
    assert.equal(tool.strict, false)
    for (const field of ['provider', 'model', ...(tool.name === 'subagent' ? ['reasoning_effort'] : [])]) {
      assert.deepEqual(tool.parameters.properties[field].oneOf, [{ type: 'string' }, { type: 'null' }])
      assert.ok(!tool.parameters.required?.includes(field))
    }
  }
})

test('explicit allowed route starts and null effort clears route-owned defaults', async () => {
  const h = await harness({ defaults: { provider: 'cpa', model: 'gpt-5.6-luna', reasoningEffort: 'high' } })
  await h.tools.get('subagent').execute({ ...base, provider: 'cpa', model: 'claude-opus-5-5', reasoning_effort: null }, h.exec)
  assert.deepEqual(h.starts[0].request.agentOptions, { provider: 'cpa', model: 'claude-opus-5-5' })
  assert.deepEqual(h.preflights, [{ provider: 'cpa', model: 'claude-opus-5-5' }])
})

test('nonempty efforts including off remain explicit', async () => {
  const h = await harness()
  await h.tools.get('subagent').execute({ ...base, provider: 'cpa', model: 'claude-opus-5-5', reasoning_effort: 'off' }, h.exec)
  assert.equal(h.starts[0].request.agentOptions.reasoningEffort, 'off')
})

test('partial routes, effort-only disallowed routes, and unauthorized routes never start', async () => {
  const h = await harness(), tool = h.tools.get('subagent')
  await assert.rejects(tool.execute({ ...base, provider: 'cpa', model: null }, h.exec), /must be supplied together/)
  await assert.rejects(tool.execute({ ...base, provider: '', model: 'claude-opus-5-5' }, h.exec), /must be supplied together/)
  await assert.rejects(tool.execute({ ...base, provider: null, model: null, reasoning_effort: 'high' }, h.exec), /not allowed/)
  await assert.rejects(tool.execute({ ...base, provider: 'openai', model: 'gpt-6.1-sol' }, h.exec), /allowed routes: cpa\/claude-opus-5-5, cpa\/gpt-5.6-luna/)
  assert.equal(h.starts.length, 0)
})

test('discovery rejects model without provider and explicit unauthorized requests', async () => {
  const h = await harness(), tool = h.tools.get('list_subagent_models')
  await assert.rejects(tool.execute({ provider: null, model: 'claude-opus-5-5' }, h.exec), /requires/)
  await assert.rejects(tool.execute({ provider: 'other', model: null }, h.exec), /not allowed/)
  await assert.rejects(tool.execute({ provider: 'cpa', model: 'hidden' }, h.exec), /not allowed/)
  assert.match(await tool.execute({ provider: 'cpa', model: 'claude-opus-5-5' }, h.exec), /high — High/)
})
