# searxng-search

SearXNG search provider for DSH. Registers a `searxng` provider with the web
capability seam (`ctx.web`) so the model's `web_search` tool queries a
self-hosted [SearXNG](https://docs.searxng.org/) instance through its JSON API.
`web_fetch` is unchanged (local HTTP).

## Requirements

A SearXNG instance with `json` enabled in `search.formats` of its
`settings.yml` (otherwise SearXNG answers `403`), e.g. the local Docker one in
`~/code/searxng` on `http://127.0.0.1:8080`.

## Install

Ask the agent to install `/path/to/dsh-plugins/searxng-search` with the plugin
manager (`install_bundle`), then restart DSH.

The bundle patch inserts the provider and sets the `web` service's
`searchProvider` to `searxng` (restating `fetchProvider: http`, since patches
replace config wholesale). `$DSH_WEB_SEARCH_PROVIDER=searxng` selects it too.

## Config

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8080` | Instance base URL; empty falls back to `$SEARXNG_ENDPOINT` |
| `categories` | `''` | Comma-separated SearXNG categories (e.g. `general,it`) |
| `engines` | `''` | Comma-separated engine names (e.g. `google,brave,bing`) |
| `language` | `''` | Language code (e.g. `en-AU`); empty lets SearXNG decide |
| `timeoutMs` | `20000` | Per-request budget |

An empty result with failing upstream engines (CAPTCHA, rate limits) is
reported as a `WEB_PROVIDER_ERROR` naming the engines, not an empty success.
