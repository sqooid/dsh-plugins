/**
 * No-token browser login for DSH web.
 *
 * DSH serves its index only to a browser holding a signed session cookie, and
 * mints that cookie only for `/?token=<per-process launch token>`. The token
 * changes on every restart. With this plugin, an index request without a valid
 * cookie gets a tiny page that navigates to `./?token=<current token>`
 * instead of a 401. DSH then mints its normal cookie and redirects to `./`.
 *
 * The bootstrap is a page, not a redirect, so the token request starts a fresh
 * same-site navigation. A redirect chain started on another site, such as a
 * Cloudflare Access login, stays cross-site. The browser then withholds the
 * SameSite=Strict cookie, so the final `./` would 401 anyway.
 *
 * DSH's Host fence still applies: only loopback, the bind address and
 * `trustedHosts` get the page. Any other Host still receives DSH's 401.
 * Everything that can reach the listener under a trusted Host is logged in.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'no-token'
export const inject = ['connection']

export const Config = z.object({
  enabled: z.boolean().default(true),
})

const TOKEN_QUERY = 'token'

/** Relative URL of the mount root from an index path (`/` or `/index.html`). */
function rootRelative(pathname) {
  const depth = Math.max(0, pathname.split('/').length - 2)
  return './' + '../'.repeat(depth)
}

function bootstrapPage(target) {
  const href = JSON.stringify(target).replaceAll('<', '\\u003c')
  const attr = target.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>dsh</title><script>location.replace(${href})</script><noscript><a href="${attr}">Continue to dsh</a></noscript>\n`
}

export function apply(ctx, config) {
  if (!config.enabled) return
  const logger = ctx.logger?.('no-token') ?? console
  const service = ctx.connection
  const proto = service === undefined ? undefined : Object.getPrototypeOf(service)
  const original = proto?.authorizeIndex
  if (typeof original !== 'function' || typeof proto.requestRejection !== 'function' || typeof proto.authenticatedUrl !== 'function') {
    logger.warn?.('no-token: connection service lacks authorizeIndex/requestRejection/authenticatedUrl; token login unchanged')
    return
  }

  function authorizeIndex(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    if (req.method !== 'GET' || url.searchParams.has(TOKEN_QUERY)) return original.call(this, req, res)
    // Host fence and cookie only. Origin and Sec-Fetch-Site guard /api writes,
    // not a top-level page load, so they are left out of this check.
    const probe = { headers: { host: req.headers.host, cookie: req.headers.cookie } }
    if (this.requestRejection(probe) !== 401) return original.call(this, req, res)
    const token = new URL(this.authenticatedUrl('http://dsh.invalid/')).searchParams.get(TOKEN_QUERY)
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
    })
    res.end(bootstrapPage(`${rootRelative(url.pathname)}?${TOKEN_QUERY}=${encodeURIComponent(token)}`))
    return false
  }

  proto.authorizeIndex = authorizeIndex
  ctx.effect(() => () => {
    if (proto.authorizeIndex === authorizeIndex) proto.authorizeIndex = original
  }, 'no-token: authorizeIndex override')
  logger.info?.('no-token: browsers on trusted hosts log in without the launch token')
}
