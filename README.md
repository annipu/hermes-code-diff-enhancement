# hermes-code-diff-enhancement

Side-by-side diff rendering for chat tool cards in **Hermes Desktop** — old
version on the left, new version on the right, instead of the stock
single-column unified view. Preview and review panes keep the stock
(unified) rendering; only the chat tool-card diff changes.

This is a **host patch**, not a plugin: `install.mjs` byte-edits two minified
files inside a Hermes Desktop app bundle you point it at.

## Scope & requirements

- macOS (tested on arm64), Node >= 18, **no npm install** (Node stdlib only).
- Targets specific Hermes Desktop builds — one recipe per build under
  `patches/<build>/manifest.json`. The installer auto-selects the recipe whose
  pinned pre/post hashes match the target app (stock or patched state of
  exactly that build); `--recipe=<id>` pins one explicitly. Current builds:
  **3b421578** (stampClock `2026-11-10T06:30:21Z`) and **8e876298**
  (stampClock `2026-11-06T01:21:46Z`). Any other build — including any
  self-updated one — is refused (full pre/post SHA-256 matching; unknown
  bytes never pass).
- Quit Hermes before applying; the installer refuses a running app.

## What gets patched

Two files under `Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/`
(per build; the 3b421578 recipe is current):

| build | file | stock SHA-256 | patched SHA-256 |
|---|---|---|---|
| 3b421578 | `diff-lines-j-Sgrhdt.js` | `1c572c790344c4ce…` | `3f3bb369c552b839…` |
| 3b421578 | `main-Dix6zEDd.js` | `b60793369050080f…` | `93079a438c0dfa1c…` |
| 8e876298 | `diff-lines-kfjp4AIL.js` | `a5f9e133eddbde80…` | `907e220f5b79b3ce…` |
| 8e876298 | `main-BCbglDVj.js` | `b28fe4dd512487c9…` | `70df202409d12346…` |

Each recipe (`patches/<build>/manifest.json`) stores **byte transforms**
(unique-anchor find/replace pairs) plus pinned pre/post hashes — not copies
of the host's minified chunks. The installer re-derives the patched bytes
from *your* stock files and refuses to write unless the result matches the
pinned post hash exactly.

## Usage

```bash
git clone https://github.com/annipu/hermes-code-diff-enhancement.git
cd hermes-code-diff-enhancement

# 1) plan — read-only, zero writes, shows current state
node install.mjs --app="/path/to/Hermes.app"

# 2) install (after quitting Hermes)
node install.mjs --app="/path/to/Hermes.app" --apply

# 3) check state / roll back (also needs --apply: it writes)
node install.mjs --app="/path/to/Hermes.app" --status
node install.mjs --app="/path/to/Hermes.app" --apply --rollback
```

Backups of your stock bytes are written to
`~/.hermes/host-patches/<recipe>-<appKey>/backup/`. Keep them — that is the
rollback source.

## Safety contract (enforced in code)

- Default run is a **read-only plan** — no writes, no directory creation.
- Writes only with an explicit `--apply`, after every precheck passes.
- Full pre/post SHA-256 asserted around every write; the transform replay
  must reproduce the pinned post bytes or nothing is written.
- Apply/rollback are **one transaction**; any failure restores every file
  that run touched (per-file isolation — one unwritable file cannot abort
  the restore of the others).
- Per-app lock file prevents concurrent installs; stale locks are detected.
- Refuses: running app, unknown/drifted bytes (exit 2), unknown arguments.
- `ps` failure is fail-closed (installation refuses).

## Adversarial tests

`tests/adversarial.py --app=<disposable-stock-copy> [--recipe=<id>]` runs an
injected-failure matrix against a throwaway copy of the stock app: tampered pre-bytes,
mid-transaction write failure (locked second file) with compensation,
partial-state recovery, corrupt-backup refusal, live/stale locks, symlinked
app paths, unknown args, zero-write plan. `tests/stock-baseline/` is derived
inside the repo (inverse of the recipe transforms, hash-asserted), so the
matrix needs no access to any private tree.

Verified: 8e876298 stock build 10/10 (2026-11-06) and 3b421578 stock build
10/10 (2026-11-11), including a full regression of the 8e line after the
multi-recipe installer change. Not simulated:
a real SIGKILL mid-write (the resulting state is the partial state covered
by the recovery case) and a failing `ps` binary (code-level fail-closed).

## Known limitations — read before installing

- **Hermes self-updates wipe this patch.** After any update the app bytes
  no longer match; re-check with `--status` and re-run only when a recipe
  for the new build exists.
- **The app's code signature becomes invalid** (expected for a byte patch).
  The installer never re-signs — that decision belongs to the machine owner.
- If the backups under `~/.hermes/host-patches/` are lost or corrupted after
  installing, rollback is no longer possible — restore the app from its
  original distribution instead.
- Only macOS with the builds listed above is tested; everything else
  is refused by design.

## License & notice

Code and transform data in this repository: MIT (see `LICENSE`).
This project is not affiliated with or endorsed by NousResearch. It does
not distribute Hermes Desktop or any of its code — see `NOTICE.md`.
