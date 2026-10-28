/**
 * SearXNG search provider for DSH.
 *
 * Registers a `searxng` search provider with the web capability seam
 * (`ctx.web`), so the model's `web_search` tool queries a self-hosted SearXNG
 * instance through its JSON API (`/search?format=json`). The instance must have
 * `json` in `search.formats` of its settings.yml.
 *
 * Select it with the `web` service's `searchProvider: searxng` (this bundle's
 * patch does that) or `$DSH_WEB_SEARCH_PROVIDER=searxng`.
 *
 * Only dependencies: the runtime's schemastery and dsh-web, resolved as peers.
 */
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'searxng-search'
export const inject = ['web']

export const PROVIDER_ID = 'searxng'

export const Config = z.object({
  /** Base URL of the SearXNG instance; falls back to $SEARXNG_ENDPOINT. */
  endpoint: z.string().default(''),
  /** Optional comma-separated categories (e.g. `general,it`). */
  categories: z.string().default(''),
  /** Optional comma-separated engine names (e.g. `google,brave,bing`). */
  engines: z.string().default(''),
  /** Optional language code (e.g. `en`, `en-AU`); empty lets SearXNG decide. */
  language: z.string().default(''),
  /** Per-request budget in ms. */
  timeoutMs: z.number().step(1).min(1).default(20000),
})

function aborted(signal, cause) {
  return new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal?.aborted ? signal.reason : cause })
}

function isAbort(error) {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

class SearXNGProvider {
  id = PROVIDER_ID

  constructor(resolve) {
    this.resolve = resolve
  }

  available() {
    return URL.canParse(this.resolve().endpoint)
  }

  async search(request, signal) {
    const options = this.resolve()
    if (signal?.aborted) throw aborted(signal)
    const url = new URL('search', options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    if (options.categories) url.searchParams.set('categories', options.categories)
    if (options.engines) url.searchParams.set('engines', options.engines)
    if (options.language) url.searchParams.set('language', options.language)

    const timeout = AbortSignal.timeout(options.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: combined })
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error)
      if (isAbort(error)) throw new WebError(`SearXNG at ${options.endpoint} timed out after ${options.timeoutMs}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
      throw new WebError(`SearXNG request to ${options.endpoint} failed: ${String(error)}. Is the container running?`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      const hint = response.status === 403 ? ' (enable `json` in search.formats of settings.yml)' : ''
      throw new WebError(`SearXNG error (HTTP ${response.status})${hint}`, 'WEB_PROVIDER_ERROR')
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error)
      throw new WebError(`SearXNG returned a non-JSON body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    const seen = new Set()
    const sources = []
    for (const item of body.results ?? []) {
      if (typeof item?.url !== 'string' || item.url === '' || seen.has(item.url)) continue
      seen.add(item.url)
      const publishedAt = item.publishedDate ?? item.pubdate
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(item.content ? { snippet: item.content } : {}),
        ...(publishedAt ? { publishedAt: String(publishedAt) } : {}),
      })
    }
    if (sources.length === 0 && (body.unresponsive_engines ?? []).length > 0) {
      const failed = body.unresponsive_engines.map((e) => (Array.isArray(e) ? e.join(': ') : String(e))).join('; ')
      throw new WebError(`SearXNG returned no results; upstream engines failed: ${failed}`, 'WEB_PROVIDER_ERROR')
    }
    const answer = Array.isArray(body.answers) && body.answers.length > 0
      ? body.answers.map((a) => (typeof a === 'string' ? a : a?.answer)).filter(Boolean).join('\n')
      : undefined
    return { ...(answer ? { answer } : {}), sources, truncated: false }
  }
}

export function apply(ctx, config) {
  const get = (field) => (typeof field?.get === 'function' ? field.get() : field)
  ctx.web.registerSearchProvider(new SearXNGProvider(() => ({
    endpoint: get(config.endpoint) || process.env.SEARXNG_ENDPOINT || '',
    categories: get(config.categories) ?? '',
    engines: get(config.engines) ?? '',
    language: get(config.language) ?? '',
    timeoutMs: get(config.timeoutMs) ?? 20000,
  })))
}
