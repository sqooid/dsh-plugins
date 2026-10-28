# whisper-dictation

[OpenWhispr](https://github.com/OpenWhispr/openwhispr)-style dictation for DSH. It uses local Whisper (you choose the model size), then AI cleanup of the transcript, plus a custom dictionary, replacement rules and snippets. You use it through DSH's own Voice Input microphone in the composer.

It plugs into the experimental speech service as one recognition provider per Whisper size (`whisper-<size>`). The shipped microphone, recording toolbar, setup prompt and **Download and prepare** cards all work with it unchanged. **It requires the Voice Input bundle** (`@deepseek-ai/dsh-experimental-voice-input-bundle`).

## What happens to a recording

1. **Whisper.** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) runs Whisper (int8 ONNX) on the CPU in a private worker process.
   - Silero VAD splits the audio into speech segments of up to 28 s and drops silence.
   - The worker starts on the first recording and exits after 15 idle minutes.
2. **Hygiene.**
   - `[BLANK_AUDIO]`, `(music)`, `♪` and similar markers are removed.
   - Whisper's silence hallucinations are dropped when they come back as an extra segment ("Thank you.", "Thanks for watching!", "you").
3. **Replacements.** Your `heard => written` rules run on whole words, case-insensitively.
4. **AI cleanup** (optional). It uses OpenWhispr's cleanup prompt verbatim, and the prompt is assembled the same way: template (`{{agentName}}`), language rule, your extra instructions, then `Custom Dictionary (use these exact spellings …): …`.
   - The transcript is sent as `<transcript>…</transcript>`.
   - The model runs at its lowest reasoning effort, with temperature 0 when that effort is `off`.
   - The output is checked:
     - `<think>` blocks and wrappers are stripped.
     - OpenWhispr's duplicated-transcript check runs.
     - A length guard catches *answers* instead of cleanups.
   - **Any failure, timeout or implausible output keeps the raw transcript.** The failure is logged.
5. **Dictionary spelling and snippets.**
   - Dictionary terms are forced to their exact spelling: `github`/`git hub` → `GitHub`.
   - Snippet triggers are expanded, longest first.

What lands in the draft is the result of step 5. You can review it before sending.

The last 20 dictations, with both the raw Whisper text and the final text plus timings, are kept in `~/.dsh/speech-to-text/whisper/history.jsonl` (set `historyLimit: 0` to keep none). The service log (`journalctl --user -u dsh-web`) gets one `[whisper-dictation]` timing line per recording and never the transcript itself.

## Choosing the model size

**Plugins → Voice input → Recognition service** lists each configured size with its download size. The first time you pick one, use **Download and prepare**. Downloads are revision-pinned and SHA-256 verified ([models.json](models.json)) and are stored under `~/.dsh/speech-to-text/whisper/models/<size>/`.

Measured on this host (8-core Graviton, CPU only, int8):

| size | download | 6.6 s clip | 32 s clip | notes |
|---|---|---|---|---|
| `tiny.en` | 104 MB | 0.4 s | 1.6 s | fast, least accurate |
| `base.en` | 161 MB | 0.6 s | 2.4 s | OpenWhispr's default size |
| `small.en` | 376 MB | 1.5 s | 6.2 s | **good default here** |
| `medium.en` | 946 MB | — | — | ~2.5× small |
| `turbo` (large-v3-turbo) | 1.04 GB | 2.7 s | 11 s | multilingual; tends to omit punctuation (cleanup restores it) |
| `large-v3` | 1.78 GB | — | — | slowest |

`.en` models are English-only. The multilingual ones (`tiny`, `base`, `small`, `medium`, `turbo`, `large-v3`) accept every Whisper language plus auto-detect. The Voice input card only has display names for Auto, English, Chinese, Cantonese, Japanese and Korean, so it shows the other languages by code (`de`, `fr` …). `distil-small.en`, `distil-medium.en` and `distil-large-v3` are also available. List the sizes you want under `models`.

## Dictionary, replacements, snippets, cleanup model

All of these are under **Plugins → Dictation** and apply from the next recording, with no restart:

- **AI cleanup** on/off, and the **cleanup model** (any model in the catalog; pick a fast one, as it runs after every recording).
- **Dictionary**: one term per line (names, products, jargon). It is used in the cleanup prompt, and differently-cased matches are corrected deterministically.
- **Replacements**: `deep seek | deepseek => DeepSeek`. These are for words Whisper consistently mishears. They run before cleanup, so the model sees the right word, and again after cleanup.
- **Snippets**: `my email => me@example.com` (`\n` for line breaks).
- **Extra instructions**, appended to the prompt. *Insert coding-agent context* adds a paragraph that biases toward technical readings ("pie test" → pytest).
- **Agent name** and **English spelling** (US/GB), as in OpenWhispr.
- **Cleanup prompt**: leave it empty for OpenWhispr's prompt, or write your own.

Whisper itself is not prompted with the dictionary. sherpa-onnx has no initial-prompt input, and OpenWhispr's echo filters exist because prompting causes prompt-echo hallucinations. Dictionary terms reach the transcript through replacements, cleanup and the spelling pass instead.

## Configuration

```yaml
- id: whisper-dictation
  name: '@local/dsh-whisper-dictation'
  config:
    dataRoot: !!js dshHomePath('speech-to-text', 'whisper')
    models: [base.en, small.en, medium.en, turbo]   # one provider each (restart)
    threads: 4                    # ONNX threads per worker
    idleTimeoutMs: 900000         # unload the worker after 15 idle minutes (0 = never)
    minSilenceSeconds: 0.8        # VAD pause that splits segments
    # live (Plugins → Dictation):
    cleanup: true
    cleanupProvider: cpa
    cleanupModel: claude-haiku-5-5
    cleanupTimeoutMs: 30000       # restart to change
    dictionary: [DeepSeek, GitHub, pytest]
    replacements: [{ from: 'deep seek|deepseek', to: DeepSeek }]
    snippets: [{ trigger: my email, replacement: me@example.com }]
```

By default the Voice Input Remote accepts at most 120 s / 4 MB per recording. To dictate longer, raise those limits in the profile patch:

```yaml
- id: api-speech-to-text
  name: '@deepseek-ai/dsh-experimental-api-speech-to-text'
  config:
    maxAudioBytes: 19300000   # ~10 min of 16 kHz PCM16
    maxDurationSeconds: 600
```

## Development

- `npm test`: unit tests for the text pipeline and the cleanup fallbacks.
- `node scripts/smoke-worker.mjs <dir> <size> <silero_vad.onnx> <file.wav>…`: run the worker against downloaded model files.
- `node scripts/smoke-provider.mjs <dataRoot> <size> <file.wav>`: inspect → download → verify → load → transcribe → idle → dispose, outside DSH.
- `node scripts/lock-models.mjs [size…]`: re-pin [models.json](models.json) to the current Hugging Face revisions.

The worker loads `sherpa-onnx-node` from the DSH installation, the same native runtime the SenseVoice provider uses, so nothing extra is installed.
