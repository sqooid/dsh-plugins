import { test } from 'node:test'
import assert from 'node:assert/strict'
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
} from '../lib/text.js'
import { postProcess } from '../lib/cleanup.js'
import { parseWave } from '../worker.js'

test('cleanTranscript drops annotations and hallucinated extra segments', () => {
  assert.equal(cleanTranscript(['[BLANK_AUDIO]']), '')
  assert.equal(cleanTranscript(['Fix the build.', 'Thank you.']), 'Fix the build.')
  assert.equal(cleanTranscript(['Thank you.']), 'Thank you.')
  assert.equal(cleanTranscript(['Thanks for watching!']), '')
  assert.equal(cleanTranscript(['(upbeat music) run   the tests', '♪♪']), 'run the tests')
  assert.equal(cleanTranscript(['Thank you for the fix, it works.']), 'Thank you for the fix, it works.')
})

test('applyReplacements matches whole words, alternatives and loose spacing', () => {
  const rules = [{ from: 'deep seek|deepseek', to: 'DeepSeek' }, { from: 'claude code', to: 'Claude Code' }]
  assert.equal(applyReplacements('ask deep seek and Deep-Seek via claude code', rules), 'ask DeepSeek and DeepSeek via Claude Code')
  assert.equal(applyReplacements('deepseeker stays', rules), 'deepseeker stays')
  assert.equal(applyReplacements('dsh rocks', [{ from: 'dsh', to: 'dsh (DeepSeek Harness)' }], { repeatSafeOnly: true }), 'dsh rocks')
})

test('enforceDictionarySpelling fixes casing and split camel case', () => {
  assert.equal(enforceDictionarySpelling('push to github and git hub, use pytest', ['GitHub', 'pytest']), 'push to GitHub and GitHub, use pytest')
  assert.equal(enforceDictionarySpelling('githubbing', ['GitHub']), 'githubbing')
})

test('expandSnippets expands triggers on boundaries, longest first', () => {
  const snippets = [{ trigger: 'my email', replacement: 'me@example.com' }, { trigger: 'my email address', replacement: 'ADDR' }]
  assert.equal(expandSnippets('Send it to my email.', snippets), 'Send it to me@example.com.')
  assert.equal(expandSnippets('My email address please', snippets), 'ADDR please')
  assert.equal(expandSnippets('notmy email', snippets), 'notmy email')
})

test('system prompt follows OpenWhispr assembly order', () => {
  const prompt = buildCleanupSystemPrompt({ agentName: 'Opus', language: 'en', instructions: 'Be terse.', dictionary: ['DeepSeek'], replacements: [{ from: 'x', to: 'Claude Code' }], snippetTriggers: ['my email'] })
  assert.match(prompt, /^You are a transcript cleanup engine/)
  assert.match(prompt, /Mentions of "Opus"/)
  const lang = prompt.indexOf('American English')
  const extra = prompt.indexOf('Be terse.')
  const dict = prompt.indexOf('Custom Dictionary (use these exact spellings when they appear in the text): DeepSeek, Claude Code, my email')
  assert.ok(lang > 0 && extra > lang && dict > extra)
  assert.equal(wrapCleanupTranscript('hi'), '<transcript>\nhi\n</transcript>\n\nOutput only the cleaned transcript.')
})

test('output guards', () => {
  assert.equal(stripThinkingTags('<think>a<think>b</think></think>Done.'), 'Done.')
  assert.equal(stripThinkingTags('Done.<think>unfinished'), 'Done.')
  assert.equal(stripWrappers('<transcript>\nHello.\n</transcript>', 'hello'), 'Hello.')
  assert.equal(stripWrappers('Cleaned transcript: Hello.', 'hello'), 'Hello.')
  assert.equal(stripWrappers('"Hello."', 'hello'), 'Hello.')
  const raw = 'please update the readme and then run the tests again'
  assert.throws(() => assertValidCleanupOutput(raw, 'Please update the README and run the tests. Please update the README and run the tests.'), /duplicated/)
  assert.doesNotThrow(() => assertValidCleanupOutput(raw, 'Please update the README, then run the tests again.'))
  assert.equal(isPlausibleCleanup('what is the capital of france', 'What is the capital of France?'), true)
  assert.equal(isPlausibleCleanup('what is the capital of france', 'The capital of France is Paris. '.repeat(10)), false)
})

function fakeLlm(reply, seen = {}) {
  return {
    async prepareCall(config, _signal, configure) {
      seen.controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
      seen.route = config
      return {
        config: { ...config, ...seen.controls },
        async *stream(options) {
          seen.options = options
          if (reply instanceof Error) throw reply
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

const settings = {
  cleanup: true, cleanupProvider: 'p', cleanupModel: 'm', cleanupPrompt: '', instructions: '', agentName: '', spelling: 'en-US',
  dictionary: ['GitHub'], replacements: [{ from: 'deep seek', to: 'DeepSeek' }], snippets: [{ trigger: 'sig line', replacement: '-- me' }],
  cleanupTimeoutMs: 1000, cleanupMaxTokens: 512,
}

test('postProcess runs replacements, cleanup, spelling and snippets', async () => {
  const seen = {}
  const result = await postProcess({ llm: fakeLlm('Ask DeepSeek on github. sig line', seen), settings, segments: ['um ask deep seek on git hub', 'Thank you.'], language: 'en', signal: new AbortController().signal })
  assert.equal(seen.options.messages[0].content[0].text, wrapCleanupTranscript('um ask DeepSeek on git hub'))
  assert.deepEqual(seen.controls, { maxTokens: 512, reasoningEffort: 'off', temperature: 0 })
  assert.equal(result.text, 'Ask DeepSeek on GitHub. -- me')
  assert.equal(result.cleaned, true)
})

test('postProcess falls back to the raw transcript when cleanup fails', async () => {
  const result = await postProcess({ llm: fakeLlm(new Error('boom')), settings, segments: ['push to git hub'], language: 'en', signal: new AbortController().signal })
  assert.equal(result.text, 'push to GitHub')
  assert.equal(result.cleaned, false)
  assert.match(result.cleanupError, /boom/)
  const answered = await postProcess({ llm: fakeLlm('Paris is the capital of France, a country in Western Europe known for its art, food, wine, fashion and history; it has been a major power for centuries and attracts tourists.'), settings, segments: ['what is the capital of france'], language: 'en', signal: new AbortController().signal })
  assert.equal(answered.text, 'what is the capital of france')
})

test('postProcess skips the model when cleanup is off', async () => {
  const result = await postProcess({ llm: fakeLlm('SHOULD NOT APPEAR'), settings: { ...settings, cleanup: false }, segments: ['hello there'], language: 'en', signal: new AbortController().signal })
  assert.equal(result.text, 'hello there')
})

test('parseWave validates canonical PCM16 WAV', () => {
  const wav = Buffer.alloc(44 + 4)
  wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40); wav.writeInt16LE(16384, 44)
  assert.deepEqual([...parseWave(new Uint8Array(wav), 1000)], [0.5, 0])
  wav.writeUInt32LE(8000, 24)
  assert.throws(() => parseWave(new Uint8Array(wav), 1000), /16 kHz/)
})
