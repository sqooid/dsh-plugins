# No-token login

DSH web only lets a browser in with its signed session cookie, and it issues that cookie only at
`/?token=<launch token>`. The token changes every time DSH restarts. With this plugin, an index
request that has no valid cookie gets a small page that opens `./?token=<current token>` for you.
DSH then sets its normal cookie (lifetime: `cookieMaxAgeDays` on the `connection` plugin) and loads
the UI. Open `https://<host>/` directly; you don't need a token.

The plugin serves a page instead of an HTTP redirect on purpose. When a login redirect from another
site (e.g. Cloudflare Access) leads to DSH, every later redirect counts as cross-site, so the
browser drops DSH's `SameSite=Strict` cookie and the UI returns 401. Because the page starts a new
same-site navigation, the cookie is sent.

**Security:** this removes DSH's own browser authentication. Anything that can reach the listener
with an accepted `Host` gets in: loopback, the bind address, and `trustedHosts`/`--trusted-host`.
Other `Host` values still get DSH's 401, which keeps DNS-rebinding protection. The `/api`
Origin/Sec-Fetch-Site checks and API credentials (`/connect`) are unchanged. Only use this plugin
when something else, such as a Zero Trust proxy or a loopback-only bind, controls who can reach the
port.

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-plugins/no-token
systemctl --user restart dsh-web   # or restart `dsh web`
```

`dsh plugin add` also adds `@local/dsh-no-token` to the profile's bundles. To turn the plugin off
without uninstalling it, set `enabled: false` on the `no-token` entry in the profile's
`cordis.patch.yml`.

## How it works

The plugin wraps `HostConnectionService.prototype.authorizeIndex` from
`@deepseek-ai/dsh-client-connection` and restores the original when it is disposed. The wrapper
only uses the service's public `requestRejection` and `authenticatedUrl` methods. If an upgrade
removes either method, the plugin logs a warning and leaves the token login unchanged.
