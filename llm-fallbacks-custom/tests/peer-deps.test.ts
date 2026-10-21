import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const root = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
  name: string
  version: string
  private?: boolean
  scripts: Record<string, string>
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const deepseekKeys = (field: Record<string, string> | undefined): string[] =>
  Object.keys(field ?? {}).filter((name) => name.startsWith('@deepseek-ai/')).sort()

describe('custom plugin peer contract', () => {
  it('keeps @deepseek-ai packages in peerDependencies only', () => {
    const peers = deepseekKeys(root.peerDependencies)
    expect(peers.length).toBeGreaterThan(0)
    for (const name of peers) {
      expect(root.dependencies?.[name], name).toBeUndefined()
      expect(root.devDependencies?.[name], name).toBeUndefined()
      expect(root.optionalDependencies?.[name], name).toBeUndefined()
    }
  })

  it('pins peers to the installed DSH 0.2.1-rc.2 runtime', () => {
    for (const [name, range] of Object.entries(root.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range, name).toBe('0.2.1-rc.2')
    }
    expect(root.peerDependencies?.['@deepseek-ai/cordis']).toBe('~4.0.5')
  })

  it('uses a local private package identity', () => {
    expect(root.name).toBe('@local/dsh-llm-fallbacks-custom')
    expect(root.private).toBe(true)
    expect(root.version).toMatch(/-local\.\d+$/)
    expect(root.keywords).toEqual(expect.arrayContaining(['dsh', 'dsh-plugin']))
  })

  it('enables peer autoinstall and keeps prepare build-only', () => {
    const workspace = readFileSync(resolve(repo, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/autoInstallPeers\s*:\s*true/)
    expect(root.scripts.prepare).toBe('pnpm run build')
    expect(root.scripts['dsh:link']).toBeUndefined()
    expect(root.scripts['dsh:link:check']).toBeUndefined()
    expect(existsSync(resolve(repo, 'scripts', 'setup-dsh-links.mjs'))).toBe(false)
  })
})
