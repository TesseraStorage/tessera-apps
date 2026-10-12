// Single source of truth for the Tessera Apps version.
//
// The version comes from the git tag (vX.Y.Z), so it cannot drift from the
// release again. Order of precedence:
//   1. TESSERA_VERSION              — explicit override (CI / local testing)
//   2. GITHUB_REF_NAME on a v* tag  — the release tag, e.g. v1.2.3 -> 1.2.3
//   3. the exact git tag at HEAD    — local `v*` checkouts
//   4. 0.0.0-0.<short-sha>          — a clearly-marked non-release build
//
// Run directly to print it:  node scripts/version.mjs
import { execFileSync } from 'node:child_process'

export function computeVersion(env = process.env) {
  const clean = (v) => String(v).trim().replace(/^v/, '')
  if (env.TESSERA_VERSION) return clean(env.TESSERA_VERSION)
  const ref = env.GITHUB_REF_NAME || ''
  if (env.GITHUB_ACTIONS && ref.startsWith('v')) return clean(ref)
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--exact-match', '--match', 'v*'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (tag) return clean(tag)
  } catch {
    // not on a tag — fall through to a dev version
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    return `0.0.0-0.${sha}`
  } catch {
    return '0.0.0-0.unknown'
  }
}

if (process.argv[1] && process.argv[1].endsWith('version.mjs')) {
  process.stdout.write(computeVersion())
}
