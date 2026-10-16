#!/usr/bin/env node
/**
 * Mirror `packages/sdk` into the standalone public repo.
 *
 * WHY A SCRIPT AND NOT A COPY. The moment the SDK exists in two working trees
 * it can differ in two working trees, and the difference is invisible until an
 * integrator hits it. This repo already carries a scar from exactly that shape:
 * The repo documents the DefiLlama adapters as "a hand-maintained mirror" kept
 * honest only by a parity test somebody remembered to write.
 *
 * So the monorepo is the source of truth and the public repo is OUTPUT.
 * Everything under `dest` that this script owns is deleted and rewritten on
 * every run — never edited by hand, and the README it writes says so.
 *
 * WHAT DOES NOT TRAVEL, and why each one:
 *
 *   node_modules   obvious.
 *   dist/          a build artifact. Shipping it in a source repo invites
 *                  someone to read a stale build as the source, and npm builds
 *                  it from `prepublishOnly` anyway.
 *   *.env, *.key   never, under any circumstance. Asserted below rather than
 *                  trusted to the ignore list, because "I filtered it" and "I
 *                  checked afterwards" are different claims and only the
 *                  second one survives a refactor of the filter.
 *   rpc-probe-results.json
 *                  a timestamped latency snapshot of third-party endpoints. It
 *                  is evidence for a decision already encoded in
 *                  `chains/endpoints.ts`, not something a consumer needs, and
 *                  it goes stale in a way that looks authoritative.
 *   test/          REMOVED FROM THE MIRROR 2026-09-25, and the reason is not
 *                  squeamishness about showing tests. THEY CANNOT RUN THERE.
 *                  `test/safe.test.ts` reads its fixtures from
 *                  `../../../ops/governance`, which exists only in the monorepo,
 *                  so `npm test` in the public repo throws ENOENT on the first
 *                  file. A suite that fails the moment anyone runs it makes the
 *                  package look broken and teaches a reader to distrust the
 *                  rest, which is worse than shipping no suite at all.
 *
 *                  It also named an operator wallet in a test title and a call
 *                  array. That wallet is already public on chain, so this is
 *                  tidiness rather than a leak — the public-surface rule is
 *                  about not advertising operator addresses, and the ENOENT
 *                  above is the part that actually decides the exclusion.
 *
 *                  If the suite should ship one day, the fix is to move those
 *                  fixtures INTO the SDK so the tests are self-contained, not to
 *                  add the directory back and hope.
 *
 * Usage:  node scripts/sync-public-repo.mjs [--dest <path>] [--dry-run]
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SDK = join(dirname(fileURLToPath(import.meta.url)), '..')
const { UNRELEASED_MODULES, stripIndex, stripManifest } = await import(new URL('./lib/unreleased.mjs', import.meta.url).href)

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const destArg = args.indexOf('--dest')
const DEST =
  destArg !== -1 && args[destArg + 1]
    ? args[destArg + 1]
    : join(homedir(), '.deepcore', 'public', 'deep-sdk')

/** Copied verbatim. Anything not named here does not travel.
 *  `assets/` (gitignored) does NOT travel: it holds the previous identity's art. The README's
 *  banner is the mirror's own `.github/assets/og-image-1200x630.png`, which this script never
 *  touches.
 *  `prompts` (the paste-into-an-agent integration prompts) travel since 0.2.0, rewritten for
 *  `LaunchpadKitV2` (they were held back while they described the first, block-denominated kit). */
const INCLUDE_DIRS = ['src', 'scripts', 'prompts']
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'schema.graphql',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
]

/** Refused even if some future edit to the lists above would let them through. */
const FORBIDDEN = [/(^|[/\\])\.env($|\.)/i, /\.key$/i, /\.pem$/i, /(^|[/\\])keystore([/\\]|$)/i]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // .cache: local scratch from the generator scripts (fetched chain lists, feed pages), gitignored here.
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.cache') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = []
for (const d of INCLUDE_DIRS) {
  const p = join(SDK, d)
  if (existsSync(p)) files.push(...walk(p))
}
/* Modules whose contracts are not deployed yet stay in the monorepo (scripts/lib/unreleased.mjs). */
const unreleased = new RegExp(`^src[/\\\\](?:${UNRELEASED_MODULES.join('|')})[/\\\\]`)
if (UNRELEASED_MODULES.length > 0) for (let i = files.length - 1; i >= 0; i--) if (unreleased.test(relative(SDK, files[i]))) files.splice(i, 1)
for (const f of INCLUDE_FILES) {
  const p = join(SDK, f)
  if (existsSync(p)) files.push(p)
}

/* The assertion, not the filter, is what makes this safe to run unattended. */
for (const f of files) {
  const rel = relative(SDK, f)
  if (FORBIDDEN.some((re) => re.test(rel))) {
    console.error(`REFUSING TO SYNC: ${rel} matches a forbidden pattern.`)
    process.exit(1)
  }
}

if (!existsSync(DEST)) {
  console.error(`Destination does not exist: ${DEST}`)
  process.exit(1)
}
if (!existsSync(join(DEST, '.git'))) {
  console.error(`Destination is not a git repo: ${DEST}\nRefusing to write into a plain directory.`)
  process.exit(1)
}

/* Clear only what this script owns. A file the public repo added on its own —
   CI config, issue templates, a CONTRIBUTING — is left alone, because the
   mirror owns the package and not the repository around it. */
for (const d of [...INCLUDE_DIRS]) {
  const p = join(DEST, d)
  if (existsSync(p) && !DRY) rmSync(p, { recursive: true, force: true })
}

let n = 0
for (const f of files) {
  const rel = relative(SDK, f)
  const target = join(DEST, rel)
  if (!DRY) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(f, target)
  }
  n++
}

/* THE MIRROR MUST NOT TRY TO REGENERATE ITS ABIs.
   `build` here is `npm run generate && tsc`, and every generator reads Foundry
   artifacts out of ../core, ../registry and ../launchpad — paths that exist
   only inside the monorepo. Copied verbatim, `npm run build` fails on a fresh
   clone with "Artifact not found", which is a broken repo for anyone who wants
   to contribute.
   The generated ABI files themselves DO travel (under each module's own
   `generated` directory), so the mirror has everything it needs to compile.
   Regeneration is a monorepo
   operation, because that is the only place the source of truth for those ABIs
   — the Solidity — exists. Rewriting the scripts here rather than editing the
   real package.json keeps that asymmetry in one place. */
if (!DRY) {
  const indexPath = join(DEST, 'src', 'index.ts')
  writeFileSync(indexPath, stripIndex(readFileSync(indexPath, 'utf8'), 'src/index.ts'))
  const pkgPath = join(DEST, 'package.json')
  const pkg = stripManifest(JSON.parse(readFileSync(pkgPath, 'utf8')))
  for (const k of Object.keys(pkg.scripts)) {
    if (k === 'generate' || k.startsWith('generate:')) delete pkg.scripts[k]
  }
  pkg.scripts.build = 'tsc -p tsconfig.build.json'
  pkg.scripts.prepublishOnly = 'npm run build'
  /* `prepare`, and it is NOT redundant with `prepublishOnly`.

     npm runs `prepare` when a package is installed FROM GIT; it runs
     `prepublishOnly` only on `npm publish`. `dist/` is gitignored and `files`
     excludes `src`, so without this a
     `npm install github:deep-core-protocol/deep-sdk` produced a package with
     neither a build nor sources — no entry point at all, `main` pointing at a
     directory that was never created. Reported by an integrator on 2026-09-13.

     Safe here in a way it would not be in the monorepo: this `build` is a bare
     `tsc`, because the ABI generators are stripped above. The monorepo's build
     runs those generators against Foundry artifacts in ../core, so a `prepare`
     there would fire on every `npm install` and fail for anyone who has not run
     `forge build`. */
  pkg.scripts.prepare = 'npm run build'
  pkg.repository = { type: 'git', url: 'git+https://github.com/deep-core-protocol/deep-sdk.git' }
  pkg.bugs = { url: 'https://github.com/deep-core-protocol/deep-sdk/issues' }
  pkg.homepage = 'https://deepcore.fun'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10))
}

const version = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')).version
console.log(`${DRY ? '[dry run] would sync' : 'synced'} ${n} files -> ${DEST}`)
console.log(`  @deepcoreprotocol/sdk@${version}`)
if (!DRY) console.log('  now: cd into the repo, review `git status`, commit, push.')
