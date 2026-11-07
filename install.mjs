#!/usr/bin/env node
// install.mjs — standalone installer for the code-diff-enhancement host patch
// (recipe cde-8e876298, Hermes Desktop build 8e876298).
//
// What it does: transforms two minified dist files inside a Hermes Desktop
// app bundle so chat tool-card diffs render side-by-side (old left / new
// right). Preview and review panes are untouched. THIS IS A HOST PATCH, not
// a plugin: it byte-edits the app you point it at.
//
// Safety contract (enforced in code, not by disclaimer):
//   • default run is a READ-ONLY plan — zero writes, zero dir creation;
//   • writes only happen with an explicit --apply (after all prechecks pass);
//   • full pre/post SHA-256 asserted around every write; replay of the
//     manifest transforms must reproduce the pinned post bytes;
//   • apply/rollback are one transaction: any failure restores every file
//     this run touched (internal errors throw to a single compensating catch);
//   • pre-bytes are backed up to a stable user dir (~/.hermes/host-patches)
//     and verified before rollback trusts them;
//   • refuses a running app; `ps` failure is fail-closed;
//   • refuses unknown/drifted builds (no recipe match) — self-updates of
//     Hermes wipe this patch; re-run after updates;
//   • per-app lock file prevents concurrent installs;
//   • macOS (arm64) only; only build 8e876298 is supported (tested).
//
// Patching invalidates the app's code signature; do not re-sign
// automatically — that is a decision for the machine's owner.
//
// Usage:
//   node install.mjs --app=<path-to-Hermes.app>            # plan (default, read-only)
//   node install.mjs --app=<...> --apply                   # install
//   node install.mjs --app=<...> --status                  # read-only state
//   node install.mjs --app=<...> --apply --rollback        # restore stock bytes
//
// No npm dependencies. Node >= 18.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const MANIFEST = JSON.parse(readFileSync(path.join(root, 'patches/8e876298/manifest.json'), 'utf8'))

const USAGE = 'usage: node install.mjs --app=<Hermes.app> [--apply] [--rollback] [--status]'
const known = new Set(['--apply', '--rollback', '--status'])
const args = process.argv.slice(2)
const appArg = args.find(a => a.startsWith('--app='))
for (const a of args) if (!a.startsWith('--app=') && !known.has(a)) { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(1) }
const APPLY = args.includes('--apply')
const ROLLBACK = args.includes('--rollback') && APPLY // rollback is also a write: requires --apply
const STATUS = args.includes('--status')
if (!appArg) { console.error(USAGE); process.exit(1) }
if (args.includes('--rollback') && !APPLY) { console.error('--rollback writes files; combine with --apply (plan run shows what would be restored)'); process.exit(1) }

const say = m => console.log(m)
const fail = (m, code = 1) => { console.error(`ERROR: ${m}`); process.exit(code) }
const sha256 = t => createHash('sha256').update(t, 'utf8').digest('hex')

// ---------- helpers ----------
function assertNoSymlinkChain(p) {
  const parts = path.resolve(p).split(path.sep)
  let cur = path.sep
  for (const part of parts) {
    if (!part) continue
    cur = path.join(cur, part)
    let st
    try { st = lstatSync(cur) } catch { return cur /* missing tail is fine, parents checked */ }
    if (st.isSymbolicLink()) fail(`symlink in path chain refused: ${cur}`)
  }
  return cur
}

const appPath = assertNoSymlinkChain(appArg.slice('--app='.length))
if (!existsSync(appPath)) fail(`app not found: ${appPath}`)
const ASSETS = path.join(appPath, 'Contents/Resources/app.asar.unpacked/dist/assets')
const manifestDir = path.join(root, 'patches/8e876298')

// ---------- process guard (fail-closed) ----------
function appRunning() {
  let ps
  try { ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (e) { return { fail: true, reason: `ps failed (${e.message}) — fail-closed` } }
  const needle = `${appPath}/Contents/MacOS/`
  return { fail: false, running: ps.split('\n').some(l => l.includes(needle)) }
}

// ---------- per-file state ----------
const fileState = f => {
  const p = path.join(ASSETS, path.basename(f.path))
  if (!existsSync(p)) return 'missing'
  const h = sha256(readFileSync(p, 'utf8'))
  if (h === f.preSha256) return 'stock'
  if (h === f.postSha256) return 'patched'
  return 'unknown'
}
const overall = () => {
  const s = MANIFEST.files.map(f => ({ name: path.basename(f.path), state: fileState(f) }))
  if (s.some(x => x.state === 'missing' || x.state === 'unknown')) return { status: 'mismatch', files: s }
  if (s.every(x => x.state === 'stock')) return { status: 'absent', files: s }
  if (s.every(x => x.state === 'patched')) return { status: 'installed', files: s }
  return { status: 'partial', files: s } // half-written: refuse, recover via rollback
}

// ---------- status (read-only) ----------
if (STATUS) {
  const st = overall()
  say(`recipe ${MANIFEST.id} — target ${MANIFEST.targetBuild}`)
  for (const f of st.files) say(`  ${f.name}: ${f.state}`)
  say(`feature state: ${st.status}`)
  if (st.status === 'partial') say('half-written state detected — recover with: --apply --rollback (backups required)')
  process.exit(0)
}

// ---------- plan (default, READ-ONLY: no mkdir, no lock, no writes) ----------
if (!APPLY) {
  const run = appRunning()
  if (run.fail) fail(run.reason)
  const st = overall()
  say(`[plan] app: ${appPath}`)
  say(`[plan] recipe ${MANIFEST.id} (${MANIFEST.editNote ?? MANIFEST.note})`)
  for (const f of st.files) say(`[plan]   ${f.name}: ${f.state}`)
  say(`[plan] feature state: ${st.status} → would ${ROLLBACK ? 'ROLLBACK' : 'APPLY'}`)
  if (st.status === 'mismatch') say('[plan] REFUSES: bytes do not match this recipe (updated or drifted build)')
  if (run.running) say('[plan] WARNING: app appears to be RUNNING — quit Hermes before --apply')
  say('[plan] no writes performed; pass --apply to proceed')
  process.exit(st.status === 'mismatch' ? 2 : 0)
}

// ---------- write path: lock, backup dir, transaction log ----------
const appKey = `${MANIFEST.id}-${sha256(appPath).slice(0, 8)}`
const stateDir = path.join(process.env.HOME, '.hermes/host-patches', appKey)
const backupDir = path.join(stateDir, 'backup')
const lockPath = path.join(stateDir, 'install.lock')
const txLog = path.join(stateDir, 'transaction.json')

if (process.platform !== 'darwin') fail('only macOS is supported (tested on arm64)')
const run = appRunning()
if (run.fail) fail(run.reason)
if (run.running) fail('target app is running — quit Hermes first')

mkdirSync(backupDir, { recursive: true })
let lockFd
try { lockFd = openSync(lockPath, 'wx') }
catch (e) {
  if (e.code === 'EEXIST') {
    const prior = readFileSync(lockPath, 'utf8').trim()
    let alive = false
    try { process.kill(Number(prior), 0); alive = true } catch {}
    fail(alive ? `another install (pid ${prior}) holds the lock: ${lockPath}` : `stale lock found (pid ${prior} not running): delete ${lockPath} and retry`)
  }
  throw e
}
writeFileSync(lockFd, String(process.pid))
closeSync(lockFd)

const touched = []
// Per-file isolation: one unwritable file must never abort the restore of
// the others (e.g. a locked file blocking the FIRST restore would otherwise
// leave every later file patched).
const restoreTouched = () => {
  const errors = []
  for (const t of [...touched].reverse()) {
    try { writeFileSync(t.path, t.bytes, 'utf8') } catch (e) { errors.push(`${path.basename(t.path)}: ${e.message}`) }
  }
  if (errors.length) throw new Error('partial restore — ' + errors.join('; ') + ` — inspect ${backupDir} and restore manually`)
}

try {
  const st = overall()
  if (ROLLBACK) {
    if (st.status === 'absent') { say('[skip] already stock (idempotent)') }
    else {
      if (st.status === 'mismatch') throw new Error('bytes are neither stock nor patched — manual inspection required (self-updated or drifted build)')
      writeFileSync(txLog, JSON.stringify({ op: 'rollback', at: new Date().toISOString(), state: st.status }) + '\n')
      for (const f of MANIFEST.files) {
        const abs = path.join(ASSETS, path.basename(f.path))
        const backup = path.join(backupDir, path.basename(f.path))
        if (!existsSync(backup)) throw new Error(`no backup for ${f.path} — cannot roll back (was the app patched on this machine?)`)
        const pre = readFileSync(backup, 'utf8')
        assert.equal(sha256(pre), f.preSha256, `backup for ${f.path} fails its pinned pre hash — refusing (backup corrupt)`)
        const current = readFileSync(abs, 'utf8')
        touched.push({ path: abs, bytes: current })
        writeFileSync(abs + '.cde-tmp', pre, 'utf8')
        renameSync(abs + '.cde-tmp', abs)
        assert.equal(sha256(readFileSync(abs, 'utf8')), f.preSha256, `post-rollback assert failed for ${f.path}`)
        say(`[rollback] ${path.basename(f.path)} → stock`)
      }
      say('[rollback] complete')
    }
  } else {
    if (st.status === 'installed') { say('[skip] already installed (idempotent)') }
    else {
      if (st.status !== 'absent') throw new Error(`feature state ${st.status} — refusing (half-written or unknown bytes; recover with --apply --rollback)`)
      writeFileSync(txLog, JSON.stringify({ op: 'apply', at: new Date().toISOString(), files: MANIFEST.files.map(f => path.basename(f.path)) }) + '\n')
      const staged = []
      for (const f of MANIFEST.files) {
        const abs = path.join(ASSETS, path.basename(f.path))
        const stock = readFileSync(abs, 'utf8')
        assert.equal(sha256(stock), f.preSha256, `${f.path}: current bytes are NOT the pinned stock (updated or drifted build) — refusing`)
        let next = stock
        for (const e of f.edits) {
          assert.equal(next.split(e.find).length - 1, 1, `${f.path}: anchor not found exactly once — refusing`)
          next = next.replace(e.find, e.replace, 1)
        }
        assert.equal(sha256(next), f.postSha256, `${f.path}: transformed bytes fail pinned post hash — recipe integrity broken`)
        writeFileSync(path.join(backupDir, path.basename(f.path)), stock, 'utf8')
        staged.push({ abs, stock, next })
      }
      for (const s of staged) {
        touched.push({ path: s.abs, bytes: s.stock })
        writeFileSync(s.abs + '.cde-tmp', s.next, 'utf8')
        renameSync(s.abs + '.cde-tmp', s.abs)
        assert.equal(sha256(readFileSync(s.abs, 'utf8')), sha256(s.next), `${s.abs}: post-write assert failed`)
        say(`[apply] ${path.basename(s.abs)} → patched`)
      }
      say('[apply] complete — restart Hermes; note the app signature is now invalid (expected for a byte patch)')
    }
  }
  writeFileSync(txLog, JSON.stringify({ op: ROLLBACK ? 'rollback' : 'apply', at: new Date().toISOString(), result: 'ok' }) + '\n')
  process.exitCode = 0
} catch (e) {
  say('[transaction FAILED] restoring this run\'s writes…')
  try { restoreTouched() } catch (e2) { console.error(`COMPENSATION FAILED: ${e2.message} — inspect ${backupDir} manually`) }
  console.error(`ERROR: transaction aborted and compensated: ${e.message}`)
  process.exitCode = 3 // return through finally so the lock is always released
} finally {
  try { unlinkSync(lockPath) } catch {}
}
