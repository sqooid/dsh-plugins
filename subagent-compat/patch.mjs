import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const defaultTarget = '/home/coder/.nvm/versions/node/v24.22.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js'
export const marker = '// Local subagent optional-selection compatibility fix v1'

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported DSH build: expected one occurrence of ${JSON.stringify(before)}`)
  return source.replace(before, after)
}

/** Patch only subagent selection fields; never relax explicit route policy. */
export function patchSource(original) {
  if (original.includes(marker)) return original
  let source = replaceOnce(original, 'function hasDelegationModelRequest(request) {', `${marker}
/** Null/empty optional selectors mean omission on gateways that require every key. */
function normalizeDelegationModelRequest(request) {
	const normalized = { ...request };
	for (const field of ["provider", "model", "reasoning_effort"]) {
		if (normalized[field] === null || normalized[field] === "") delete normalized[field];
	}
	return normalized;
}
function hasDelegationModelRequest(request) {`)
  source = replaceOnce(source,
    'async function listSubagentModels(ctx, policy, request, signal) {',
    'async function listSubagentModels(ctx, policy, request, signal) {\n\trequest = normalizeDelegationModelRequest(request);')
  source = replaceOnce(source, 'const modelRequest = args;', 'const modelRequest = normalizeDelegationModelRequest(args);')

  // Property-map authoring syntax: oneOf is supported by dsh-tools. The optional
  // fields remain optional, but forced-present keys have a valid null sentinel.
  for (const field of ['provider', 'model', 'reasoning_effort']) {
    const regex = new RegExp(`(${field}: \\{\\n[\\t ]+)type: "string",`, 'g')
    let count = 0
    source = source.replace(regex, (match, prefix) => {
      count++
      return `${prefix}oneOf: [{ type: "string" }, { type: "null" }],`
    })
    const expected = field === 'reasoning_effort' ? 1 : 2
    if (count !== expected) throw new Error(`Unsupported DSH build: expected ${expected} optional ${field} schemas, got ${count}`)
  }
  source = source.replaceAll('Omit `provider`, `model`, and `reasoning_effort` to use', 'Omit `provider`, `model`, and `reasoning_effort` (or pass null/empty strings) to use')
  source = source.replaceAll('Registered LLM provider id. Omit to list providers.', 'Registered LLM provider id. Omit, or pass null/empty string, to list allowed providers.')
  source = source.replaceAll("Exact model id to inspect. Requires provider; omit to list that provider's advertised models.", "Exact model id to inspect. Requires provider; omit, or pass null/empty string, to list that provider's allowed advertised models.")
  // Error recovery should reveal permitted routes, rather than invite guessing.
  source = replaceOnce(source,
    'throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);',
    'throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session; allowed routes: ${policy.routes.map((route) => `${route.provider}/${route.model}`).join(", ") || "(none)"}. Use list_subagent_models to inspect them.`);')
  return source
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = fs.realpathSync(process.argv.find(arg => arg.startsWith('--target='))?.slice(9) ?? defaultTarget)
  if (!target.endsWith('/dsh-tool-subagent/lib/index.js')) throw new Error(`Refusing unexpected target: ${target}`)
  const original = fs.readFileSync(target, 'utf8')
  const patched = patchSource(original)
  if (patched === original) {
    console.log(`Already patched: ${target}`)
  } else if (!process.argv.includes('--apply')) {
    console.log(`Compatible; run with --apply to patch: ${target}`)
  } else {
    const backup = `${target}.subagent-compat-v1.bak`
    // Do not overwrite an existing backup or a changed file between read/write.
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL)
    if (fs.readFileSync(target, 'utf8') !== original) throw new Error('Target changed during patch; retry')
    fs.writeFileSync(target, patched)
    console.log(`Patched: ${target}\nBackup: ${backup}\nRestart DSH to load the fix.`)
  }
}
