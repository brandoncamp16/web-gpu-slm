# Project Overview: WebGPU SLM vs. Cloud Accessibility Benchmark

## 🎯 Goal & Architecture
A cross-platform WebGPU-based web application designed to benchmark client-side Small Language Models (SLMs) against cloud-based accessibility baselines (OpenAI `gpt-4o-mini` / `gpt-4o`).

The primary objective is to evaluate privacy-preserving, zero-bandwidth vision-to-text inference for accessibility applications (e.g., smart glasses and screen readers like NVDA/JAWS), testing key metrics such as:
- **Time To First Token (TTFT)**
- **Total Latency**
- **Tokens per second (tok/s)**
- **BLEU-4 and chrF Accuracy Scores** (comparing local SLM output against cloud baseline descriptions and VizWiz human captions)
- **Network traffic** during inference (privacy: local should be zero)

---

## 🛠️ Technology Stack
- **Frontend Engine**: WebGPU (Chrome/Edge 113+, Safari 26+), model runs in a Web Worker (main-thread fallback)
- **ML Framework**: `@huggingface/transformers` v4.3.1 on onnxruntime-web, served from `frontend/js/vendor/` (official bundle + one patch: model sessions load one at a time to cut peak memory). Regenerate with `scripts/vendor-transformers.sh`; don't edit the vendored file by hand.
- **Vision Models** (registry in `frontend/js/models.js`): `HuggingFaceTB/SmolVLM2-256M-Video-Instruct` (default), `HuggingFaceTB/SmolVLM2-500M-Video-Instruct`, `onnx-community/Janus-Pro-1B-ONNX`, `onnx-community/Qwen3.5-2B-ONNX-OPT`
- **Cloud Baselines**: Node.js/Express backend calling the OpenAI API (`gpt-4o-mini`, `gpt-4o`); `gpt-4o` also acts as the AI judge
- **Dataset**: VizWiz-Captions validation split (multi-reference scoring against human captions)
- **Storage**: MongoDB (runs, AI judge reviews, browser diagnostics)
- **Dockerized Container**: All made using docker compose to ensure it can easily be deployed across systems.
- **Config**: `.env` (dev) / `prod.env` (prod) are committed and hold no secrets; `OPENAI_API_KEY` goes only in the gitignored `secrets.env`.
- **Full setup, methodology and sources**: see `documentation.md`.

---

## 📁 Project Structure
```text
web-gpu-slm/
├─ backend/
│  ├─ Dockerfile
│  ├─ mongo-init/init-mongo.js      # Creates the benchmarkRuns collection on first DB start
│  ├─ package.json                  # Project dependencies & scripts
│  ├─ server.js                     # Express API: run storage (MongoDB), stats, CSV/JSON export
│  ├─ cloud.js                      # OpenAI cloud baseline (streaming, server-side TTFT/latency)
│  ├─ metrics.js                    # sacreBLEU-compatible BLEU-4 & chrF (single + multi-reference), summary statistics
│  ├─ vizwiz.js                     # VizWiz-Captions dataset: annotation download, seeded sampling, image cache
│  ├─ images.js                     # Test images stored with runs (shown in reports, sent to the AI judge)
│  └─ judge.js                      # AI judge: LLM pros/cons of local vs cloud over the last 10 runs
├─ frontend/
│  ├─ css/
│  │  └─ style.css                  # UI styling
│  ├─ js/
│  │  ├─ batch.js                   # VizWiz dataset batches (random sample, progress, summary, resume)
│  │  ├─ findings.js                # Plain-language conclusions generated from the stats
│  │  ├─ batchview.js               # Batch viewer: step through a batch's images with ‹ › arrows
│  │  ├─ charts.js                  # SVG charts for the Results view
│  │  ├─ common.js                  # Shared helpers: formatting, stat tiles, series names/colors
│  │  ├─ diagnostics.js             # Browser "flight recorder": streams load/run steps to /api/diagnostics
│  │  ├─ engine.js                  # Model engine (transformers.js): pre-download, load, warm-up, generate
│  │  ├─ engine-client.js           # Page-side client: runs the engine in the worker (or on the page as a fallback)
│  │  ├─ inference-worker.js        # Background Web Worker that hosts the engine so the page stays responsive
│  │  ├─ models.js                  # Model registry: models, precision presets, file names
│  │  ├─ network.js                 # Network measurement (Resource Timing) shared by page and worker
│  │  ├─ recovery.js                # Phone crash recovery (retry up to 3 crashes in a row)
│  │  ├─ results.js                 # Results & Stats dashboard and per-run reports
│  │  ├─ main.js                    # UI wiring: model loading, image handling, runs, upload batches, routing
│  │  └─ vendor/transformers-4.3.1.min.js  # Pinned, patched transformers.js (see scripts/vendor-transformers.sh)
│  ├─ nginx/
│  │  ├─ nginx.dev.conf             # http (port 80)
│  │  └─ nginx.prod.conf            # https with the local certificate; serves /ca.crt over http
│  ├─ Dockerfile
│  └─ index.html                    # Main UI dashboard (Model selection, image preview, metrics dashboard)
├─ .env                            # Committed dev config (no API keys!)
├─ .gitignore
├─ secrets.env.example              # Copy to secrets.env (gitignored) and set OPENAI_API_KEY
├─ certs/                          # Local HTTPS certificate + CA (gitignored; created by scripts/make-local-cert.sh)
├─ scripts/
│  ├─ make-local-cert.sh            # Creates the local CA and HTTPS certificate for prod mode (iPhone testing)
│  └─ vendor-transformers.sh        # Downloads transformers.js 4.3.1, verifies it, applies the memory patch
├─ AGENTS.md                        # Code guidelines & project context
├─ docker-compose.dev.yml          # Dev overrides (http)
├─ docker-compose.prod.yml         # Prod overrides (https, mounts certs/)
├─ docker-compose.yml              # Base services: frontend (nginx), backend, mongodb
├─ documentation.md                # Setup, usage, methodology, sources & references
└─ prod.env                        # Committed prod config (no API keys!)
