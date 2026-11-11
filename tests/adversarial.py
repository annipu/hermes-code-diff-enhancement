#!/usr/bin/env python3
# Adversarial matrix for install.mjs (auto-selected or --recipe=<id>) against a
# disposable stock copy. Injects failures instead of only testing happy paths:
# tampered pre-bytes, mid-transaction write failure (uchg on the 2nd file),
# partial state recovery, corrupt backup refusal, live/stale locks, symlinked
# app path, unknown args. ps-failure fail-closed is a code-level guarantee
# (execFileSync catch -> refuse) and is not simulated here.
import hashlib, json, os, pathlib, shutil, subprocess, sys

P = pathlib.Path(__file__).resolve().parents[1]          # .local/tmp/cde-public
# target app comes from --app=<Hermes.app> (a disposable COPY of a stock
# app; this matrix mutates its files). --recipe=<id> pins a recipe; by
# default the recipe whose files match the app bytes is auto-selected.
_app = next((a[6:] for a in sys.argv[1:] if a.startswith('--app=')), None)
_rid = next((a[9:] for a in sys.argv[1:] if a.startswith('--recipe=')), None)
if not _app:
    print('usage: adversarial.py --app=<path-to-disposable-stock-Hermes.app-copy> [--recipe=<id>]')
    sys.exit(2)
APP = pathlib.Path(_app)
ASSETS = APP / 'Contents/Resources/app.asar.unpacked/dist/assets'
# self-contained stock source: stock bytes pinned by the recipe hashes
STOCK_SRC = pathlib.Path(__file__).resolve().parent / 'stock-baseline'
_patches = P / 'patches'
_all = {m['id']: m for m in (
    json.loads((_patches / d / 'manifest.json').read_text(encoding='utf-8'))
    for d in sorted(os.listdir(_patches)) if (_patches / d / 'manifest.json').exists())}

def _file_ha(name):
    p = ASSETS / name
    return sha(p) if p.exists() else None

def _matches(m):
    return all(_file_ha(f['path'].split('/')[-1]) in (f['preSha256'], f['postSha256']) for f in m['files'])

sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

if _rid:
    if _rid not in _all:
        sys.exit(f'unknown recipe id: {_rid} (have: {", ".join(_all)})')
    M = _all[_rid]
else:
    cands = [m for m in _all.values() if _matches(m)]
    if len(cands) != 1:
        sys.exit(f'auto-match found {len(cands)} recipes; pass --recipe=<id> (have: {", ".join(_all)})')
    M = cands[0]
print(f'[adversarial] recipe {M["id"]} — target {M["targetBuild"]}')
for _n in (f['path'].split('/')[-1] for f in M['files']):
    assert (STOCK_SRC / _n).exists(), f'stock baseline missing for {_n}'
PRE = {f['path'].split('/')[-1]: f['preSha256'] for f in M['files']}
POST = {f['path'].split('/')[-1]: f['postSha256'] for f in M['files']}
DL, MAIN = (f['path'].split('/')[-1] for f in M['files'])
APPKEY_DIR = pathlib.Path(os.environ['HOME']) / '.hermes/host-patches'
def state_dir():
    # exact state dir for THIS recipe + THIS app (mirrors install.mjs appKey);
    # never scan other apps' or other recipes' leftovers
    key = f"{M['id']}-{hashlib.sha256(str(APP).encode()).hexdigest()[:8]}"
    d = APPKEY_DIR / key
    return d if (d / 'backup').exists() or (d / 'install.lock').exists() else None

def run(*extra):
    r = subprocess.run(['node', str(P / 'install.mjs'), f'--app={APP}', *extra],
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(('PASS' if ok else 'FAIL'), name, ('| ' + detail[:160]) if detail and not ok else '')

def restore_stock():
    for n in (DL, MAIN):
        shutil.copyfile(STOCK_SRC / n, ASSETS / n)

try:
    # 1. plan is zero-write: no lock, target bytes unchanged
    h0 = (sha(ASSETS / DL), sha(ASSETS / MAIN))
    code, out = run()
    locks_before = list(APPKEY_DIR.glob('*/install.lock')) if APPKEY_DIR.exists() else []
    check('plan-zero-write', code == 0 and (sha(ASSETS / DL), sha(ASSETS / MAIN)) == h0 and not locks_before, out[-200:])

    # 2. tampered pre-bytes refused (plan flags mismatch, apply refuses)
    orig = (ASSETS / DL).read_bytes()
    (ASSETS / DL).write_bytes(b'// tampered stock')
    code, out = run()
    code2, out2 = run('--apply')
    check('tamper-pre-refused', 'mismatch' in out and code == 2 and code2 != 0, f'{code}/{code2} {out2[-160:]}')
    (ASSETS / DL).write_bytes(orig)

    # 3. mid-transaction write failure compensated (2nd file blocked via uchg)
    subprocess.run(['chflags', 'uchg', str(ASSETS / MAIN)], check=True)
    code, out = run('--apply')
    subprocess.run(['chflags', 'nouchg', str(ASSETS / MAIN)], check=True)
    check('write-fail-compensated', code == 3 and sha(ASSETS / DL) == PRE[DL] and sha(ASSETS / MAIN) == PRE[MAIN],
          f'exit={code} dl={sha(ASSETS/DL)[:8]} main={sha(ASSETS/MAIN)[:8]} {out[-200:]}')

    # 4. partial state: recover via rollback
    code, out = run('--apply')
    sd = state_dir()
    assert sd, 'state dir missing after apply'
    shutil.copyfile(sd / 'backup' / MAIN, ASSETS / MAIN)   # simulate half-write
    code, out = run('--status')
    partial_seen = 'partial' in out
    code, out = run('--apply')
    refused = code != 0
    code, out = run('--apply', '--rollback')
    check('partial-recover', partial_seen and refused and code == 0
          and sha(ASSETS / DL) == PRE[DL] and sha(ASSETS / MAIN) == PRE[MAIN],
          f'partial={partial_seen} refused={refused} rb={code}')

    # 5. corrupt backup refused, site not worsened (still installed)
    run('--apply')
    (sd / 'backup' / MAIN).write_bytes(b'corrupt-backup')
    code, out = run('--apply', '--rollback')
    not_worsened = sha(ASSETS / DL) == POST[DL] and sha(ASSETS / MAIN) == POST[MAIN]
    check('backup-corrupt-refused', code == 3 and not_worsened and 'backup' in out, f'exit={code} worsened={not not_worsened}')
    shutil.rmtree(sd)          # clean slate: rebuilt by next apply
    restore_stock()

    # 6. live lock refused
    run('--apply')             # ensure state dir + backups exist again
    sd = state_dir()
    (sd / 'install.lock').write_text(str(os.getpid()))
    code, out = run('--apply')
    (sd / 'install.lock').unlink()
    check('live-lock-refused', code != 0 and 'holds the lock' in out, f'exit={code} {out[-140:]}')

    # 7. stale lock -> actionable hint
    (sd / 'install.lock').write_text('999999')
    code, out = run('--apply')
    (sd / 'install.lock').unlink()
    check('stale-lock-hint', code != 0 and 'stale lock' in out, f'exit={code}')

    # 8. symlinked app path refused
    link = pathlib.Path('/tmp/cde-adv-app-link.app')
    if link.is_symlink():
        link.unlink()
    link.symlink_to(APP)
    r = subprocess.run(['node', str(P / 'install.mjs'), f'--app={link}'], capture_output=True, text=True)
    code = r.returncode
    link.unlink()
    check('symlink-refused', code != 0 and 'symlink' in (r.stdout + r.stderr), f'exit={code}')

    # 9. unknown argument refused
    code, out = run('--bogus')
    check('unknown-arg-refused', code == 1 and 'unknown argument' in out, f'exit={code}')

    # final: leave the copy stock
    run('--apply', '--rollback')
    check('final-stock', sha(ASSETS / DL) == PRE[DL] and sha(ASSETS / MAIN) == PRE[MAIN])

except Exception as e:
    results.append(('matrix-crashed', False))
    print('FAIL matrix-crashed |', str(e)[:200])
finally:
    subprocess.run(['chflags', 'nouchg', str(ASSETS / MAIN)], capture_output=True)  # belt & braces

failed = [r[0] for r in results if not r[1]]
print(f"\nADVERSARIAL: {len(results) - len(failed)}/{len(results)} passed")
if failed:
    print('failures:', failed)
sys.exit(1 if failed else 0)
