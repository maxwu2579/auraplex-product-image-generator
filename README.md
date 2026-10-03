# Auraplex Product Image Generator — Milestone 5R

Local product-image editor with FastAPI background removal, conservative subject detection, and a user-supplied local Brand Logo Library. Product source images remain in memory; only Brand Logos explicitly saved by the user are persisted.

## Requirements

- Node.js and npm for the frontend.
- Python 3.11–3.13 for the backend. The installed system Python 3.14 on this workstation is not supported by `rembg`; the project environment was created with the bundled Python 3.12.
- Internet access on first background-removal use to download the local `u2netp` model. Subsequent processing uses the cached model. No paid API is used.

## Run locally

Open two PowerShell terminals from the project directory:

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

If Python 3.12 is not registered with `py` on this workstation, use `C:\Users\25795\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe` in place of `py -3.12` for the virtual-environment creation command.

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:3000`. Next.js proxies local `/api/...` routes to FastAPI on `127.0.0.1:8000`; both processes must be running. `/api/health` only confirms that the backend process responds, not that the model is loaded.

## Windows One-Click Launch

**First-time setup:** the backend `.venv` and `frontend\node_modules` must already exist (see *Run locally*). Then double-click **Start Auraplex Tool.bat** in the project folder. The first launch builds the frontend once (about a minute).

**Desktop shortcuts (optional, no admin rights):** run once

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File launcher\Install-Desktop-Shortcuts.ps1
```

This creates **Auraplex Image Tool** and **Stop Auraplex Tool** on the desktop. Delete the two shortcuts to remove them.

**Daily use:** double-click **Auraplex Image Tool**. It starts the backend (`uvicorn`, no reload) and the production frontend (`npm run start`) on `127.0.0.1:8000` / `127.0.0.1:3000` in the background, waits for both health checks, and opens the app in an Edge app window (default browser if Edge is unavailable). If the app is already running, it only opens a new window. A port held by another program is reported instead of starting a duplicate.

**Stop:** double-click **Stop Auraplex Tool** (or `Stop Auraplex Tool.bat`). Only processes of this project folder are stopped; other Python/Node programs are untouched. Brand Library data in `data/brand_logos/` is never modified by the launcher.

**Rebuild:** automatic. The launcher records a fingerprint of the frontend sources/config in `runtime\frontend-build.json` and runs `npm run build` only when the build is missing or those files changed. A failed build stops the launch and is logged.

**Logs:** `logs\backend.log`, `logs\frontend.log`, `logs\frontend-build.log` (each keeps one `.previous.log`) and `logs\launcher.log`. Process state lives in `runtime\`. Both folders are Git-ignored.

**Start with Windows (not configured):** to enable later, place a copy of the *Auraplex Image Tool* shortcut in the folder opened by `Win+R` → `shell:startup`.

## Current workflow

- Choose top and bottom modes, enter a brand or upload a logo, and edit the two text lines. Entering a saved brand loads its Logo directly from local storage without rerunning background removal. An unknown brand shows a normal “not saved locally” state; the editor remains usable.
- Upload a Brand Logo to preview it. **Save Brand** stores it under the normalized brand key. For an existing brand, **Replace Logo** opens a new upload and **Confirm Replace Logo** must be clicked before the saved entry changes. Clearing or switching the brand name clears the current Logo but never deletes saved assets.
- Upload 1–5 JPG, PNG, or WEBP product source images, at most 10 MB each. Each is processed in sequence. The backend removes the background, crops to the nontransparent alpha bounds, and uses alpha connected components to propose subject candidates.
- Review the whole processed image and candidate thumbnails for each source. Large candidates are selected by default; small marks remain visible but unselected. Whole-image and individual-subject modes are mutually exclusive. Click **确认所选主体并应用到画布** to place selected items; at most five final canvas items are allowed. Removing or retrying a source also removes its prior canvas items.
- Strongly touching, overlapping, shadow-connected, or heavily watermarked objects may remain one candidate. Whole processed image is always available as a fallback; this milestone does not provide semantic instance segmentation.
- Product auto-layout uses cropped foreground dimensions, centralized safe margins, and deterministic scoring of predefined arrangements for 1–5 items. Two wide products can stack; three- and five-item layouts choose between balanced row patterns. Drag or resize products; Reset Layout restores the optimized positions. The canvas uses 1000 × 1000 logical coordinates and editor guides live outside its pixels.
- Select a product and click **擦除清理** to erase pixels with a round hard brush sized in source pixels. Erase only makes the brushed area transparent; it does not reconstruct content hidden by a watermark. The editor works on the product image's own W × H pixels and keeps its size, RGB and all other alpha values; nothing on the canvas changes until **应用**. **撤销笔画** undoes the last 20 strokes, **重置清理** returns to the processed image, **取消** / Escape discard the draft, and **撤销上次清理** restores the previous applied version once. Cleanup never moves or resizes products and never reruns auto-layout; export always uses the latest applied version. Cleanup is kept in memory only and is dropped when a source is removed or reprocessed.
- Optional top-right and bottom-right images each default to **Auto remove background**. They use the same local processing endpoint as product images and appear as cropped transparent PNGs. Turn the checkbox off to display the untouched original rectangle without calling the backend; switching it back on reprocesses the retained source file. Each can be dragged, resized, and reset within its own canvas region.
- Manually uploaded Brand Logo has the same default-on background-removal toggle. Transparent PNG/WEBP assets keep their existing alpha mask and are cropped without a second model pass, preserving fine lettering; opaque images still use `rembg`. Turn the toggle off to display the untouched original. Both the original and, when enabled, processed PNG are saved only on explicit confirmation. Online search and SQLite remain unimplemented.
- Brand Logo placement uses a dedicated centered safe box in each top layout, with less redundant padding after the backend's transparent-margin crop. Failed Logo processing retains the source for retry or original-image mode.
- Download PNG or Download JPG from the editor toolbar. Both export the current Konva composition at exactly 1000 × 1000 pixels, with a white background. Export excludes selection handles and the DOM-only layout guides. Processing disables the buttons; assets still loading produce a clear retry message. Files are named `product-image-YYYYMMDD-HHMMSS.png` or `.jpg`.

## Checks

```powershell
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
```

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q --basetemp=.pytest_tmp
```

The explicit pytest base directory avoids the Windows profile temp-folder permission issue observed on this workstation. It contains disposable test files and is Git-ignored.

## Local Brand Logo storage

By default, saved user-provided Logos live in `data/brand_logos/` beside `frontend/` and `backend/`. `brands.json` holds unique normalized keys and relative asset paths; `brand-name/` directories hold versioned originals and processed PNGs. The entire runtime directory is Git-ignored. Back it up if you need to preserve your library across workstation changes. For isolated tests, set `AURAPLEX_BRAND_LIBRARY_ROOT` before starting the backend to point it at another directory.

The library is local-only and intended for a single backend process. It does not provide user accounts, cloud sync, aliases, fuzzy matching, online Logo search, or LAN access. A corrupt manifest is reported and not overwritten automatically. Brand names currently require a normalized ASCII key (English letters/digits); names such as `Mercedes Benz` and `Mercedes-Benz` resolve to the same key.
