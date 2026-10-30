# WebGPU SLM Accessibility Benchmark: Setup & Documentation

A web app that benchmarks small vision-language models running **on the user's device** (in the browser, on the GPU through WebGPU) against **cloud** vision models (OpenAI GPT-4o / GPT-4o mini). It's built for accessibility research: describing photos for blind and low-vision users, and comparing speed, description quality, and privacy (network traffic) between on-device and cloud models.

**Contents**
1. [How It Works](#1-how-it-works)
2. [Setup](#2-setup)
3. [HTTPS and iPhone Testing](#3-https-and-iphone-testing)
4. [Using the App](#4-using-the-app)
5. [Metrics and Methodology](#5-metrics-and-methodology)
6. [Data, Storage and API](#6-data-storage-and-api)
7. [Troubleshooting](#7-troubleshooting)
8. [Sources and References](#8-sources-and-references)

---

## 1. How It Works

```text
Browser (Chrome / Edge / Safari 26+)
 ├─ Page (frontend/index.html, js/main.js …): UI, charts, results
 └─ Web Worker (js/inference-worker.js → js/engine.js)
      transformers.js + onnxruntime-web on WebGPU: the local model runs here
        │  (model weights are downloaded once from Hugging Face and cached in the browser)
        ▼
nginx (frontend container): serves the page, proxies /api
        ▼
Node.js / Express (backend container)
 ├─ /api/cloud/describe → OpenAI Chat Completions (streaming): cloud baseline
 ├─ scoring (sacreBLEU-compatible BLEU-4 and chrF), stats, CSV/JSON export
 ├─ VizWiz-Captions dataset (captions + image cache)
 └─ AI judge (OpenAI) reviews of recent runs
        ▼
MongoDB (mongodb container): runs, AI judge reviews, browser diagnostics
```

- **Local inference** happens entirely in the browser. During it, the page measures its own network requests (expected: zero).
- **Cloud inference** goes from the backend to OpenAI, so the API key never reaches the browser.
- **Docker Compose** runs three containers: `frontend` (nginx), `backend` (Node.js) and `mongodb`.

## 2. Setup

### 2.1 Requirements
- **Docker Engine** with the **Docker Compose** plugin (`docker compose version`). On Windows, Docker Desktop with the WSL 2 backend works.
- **A browser with WebGPU:** Chrome or Edge 113+, Safari 26+ (macOS / iOS), or a Firefox version with WebGPU enabled.
- **An OpenAI API key** for the cloud baseline and the AI judge. This is optional: without it, local runs still work with manually typed references.

### 2.2 Get the code
```bash
git clone https://github.com/brandoncamp16/web-gpu-slm.git
cd web-gpu-slm
```

### 2.3 Configuration files

| File | In git | Purpose |
|---|---|---|
| `.env` | yes | **Development** settings (plain http). Used automatically by `docker compose`. |
| `prod.env` | yes | **Production** settings (https with the local certificate). Used with `--env-file prod.env`. |
| `secrets.env` | **no** (gitignored) | The OpenAI API key. Loaded only into the backend container. Create it from `secrets.env.example`. |
| `certs/` | **no** (gitignored) | Local HTTPS certificate and CA, created by `scripts/make-local-cert.sh` (prod only). |

**Variables in `.env` / `prod.env`**

| Variable | Example | Meaning |
|---|---|---|
| `COMPOSE_PATH_SEPARATOR` | `:` | Separator for `COMPOSE_FILE` |
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.dev.yml` | Compose files merged for this mode (`…prod.yml` in `prod.env`) |
| `MONGODB_URI` | `mongodb://MongoAdmin:<password>@mongodb:27017/docker-website?authSource=admin` | Backend connection to MongoDB |
| `ADMIN_DEFAULT_PASSWORD` | `<password>` | MongoDB root password; must match the one in `MONGODB_URI`. Applied only when the database volume is first created. |
| `NODE_ENV` | `development` / `production` | Node.js environment for the backend |
| `CORS_ORIGIN` | `http://localhost` / `https://192.168.68.61` | The address the app is opened from |

**Variables in `secrets.env`**

| Variable | Required | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | for the cloud baseline and AI judge | OpenAI API key |
| `JUDGE_MODEL` | no (default `gpt-4o`) | Model used by the AI judge |

```bash
cp secrets.env.example secrets.env   # then set OPENAI_API_KEY=sk-...
```
Never put the API key in `.env` or `prod.env`: those files are committed.

### 2.4 Build and run

| | Development (http, port 80) | Production (https, ports 80 + 443) |
|---|---|---|
| Start (detached) | `docker compose up -d --build` | `docker compose --env-file prod.env up -d --build` |
| Start in the foreground (logs on screen) | `docker compose up --build` | `docker compose --env-file prod.env up --build` |
| Backend logs | `docker compose logs -f backend` | `docker compose --env-file prod.env logs -f backend` |
| Stop | `docker compose down` | `docker compose --env-file prod.env down` |
| Open | `http://localhost` | `https://<PC-IP>` (see section 3) |

- **Shared data:** both modes use the same Docker volumes, so stored runs and cached files carry over when you switch.
- **Prod requires the certificate:** create it first (section 3), or nginx won't start.

## 3. HTTPS and iPhone Testing

Browsers only enable **WebGPU and the camera on secure pages**: https, or `localhost` on the same machine. To test from a phone, prod mode serves the app over https with a certificate from your own small **local certificate authority (CA)**. No apps are needed on the phone.

**1. Create the certificate** (once, and again if the PC's IP address changes):
```bash
./scripts/make-local-cert.sh            # auto-detects the PC's LAN IP
./scripts/make-local-cert.sh 192.168.1.50 mypc.local   # optional extra addresses/names
```
- **Files created in `certs/`:**
  - `ca.crt`: the public CA certificate, to install on the phone;
  - `ca.key`: the CA private key. **Keep it private.**
  - `server.crt` / `server.key`: the certificate nginx serves.
- **Re-runs:** an existing CA is reused, so phones that already trust it keep working.
- **Apple's rules:** the certificate meets Apple's requirements for trusted certificates (validity of 825 days or less, subject alternative names, and server authentication).
- **Limited CA:** it can only vouch for private-network addresses (10.x, 172.16–31.x, 192.168.x, 127.x) and `localhost` / `.local` names, so a leaked `ca.key` couldn't impersonate real websites. If a device rejects it, delete `certs/` and re-run with `--no-name-constraints`.

**2. Start prod mode:** `docker compose --env-file prod.env up -d --build`, and set `CORS_ORIGIN` in `prod.env` to `https://<PC-IP>`.

**3. Trust the CA on the iPhone** (once, on the same Wi-Fi as the PC):
1. In **Safari**, open `http://<PC-IP>/ca.crt` and tap **Allow**.
2. Open **Settings → Profile Downloaded → Install**.
3. Open **Settings → General → About → Certificate Trust Settings** and turn on **WebGPU SLM Benchmark Local CA**.
4. Open `https://<PC-IP>` in Safari.

When you're done, remove the profile under **Settings → General → VPN & Device Management**.

## 4. Using the App

### 4.1 Local models

| Model (in the app) | Hugging Face page (files used) | Original model | Download (default preset) | Notes |
|---|---|---|---|---|
| SmolVLM2 256M | [HuggingFaceTB/SmolVLM2-256M-Video-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM2-256M-Video-Instruct) | same | ≈ 210 MB | Default. The model that fits on an iPhone. |
| SmolVLM2 500M | [HuggingFaceTB/SmolVLM2-500M-Video-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct) | same | ≈ 390 MB | Desktop |
| Janus-Pro 1B | [onnx-community/Janus-Pro-1B-ONNX](https://huggingface.co/onnx-community/Janus-Pro-1B-ONNX) | [deepseek-ai/Janus-Pro-1B](https://huggingface.co/deepseek-ai/Janus-Pro-1B) | ≈ 2.4 GB | Desktop; one part runs on the CPU (WebAssembly), like the official Janus WebGPU demo |
| Qwen3.5 2B | [onnx-community/Qwen3.5-2B-ONNX-OPT](https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX-OPT) | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) | ≈ 1.6–1.8 GB | Desktop; images scaled to 448 px on the long side; "thinking" mode off |

**Precision presets** (the files actually downloaded are recorded with every run):

| Preset | Weights / math | Needs fp16 GPU support |
|---|---|---|
| **Balanced** (default) | 4-bit weights, fp16 embedding lookup, fp32 math | yes |
| Fast | 4-bit weights, fp16 math | yes |
| Compatible | 4-bit weights, fp32 math | no |
| CPU only | Compatible files on the WebAssembly CPU backend | no (no GPU) |

When Balanced isn't available (no fp16 shader support, or a model without that preset), the app picks the next option that works.

- **Warm-up:** a short generation on a gray image after loading compiles the GPU shaders, so the first measured run isn't a cold start.
- **Pre-download:** model files are downloaded **one at a time** straight into the browser's cache before loading, which keeps memory low on phones.
- **One part at a time:** the app serves its own pinned copy of transformers.js 4.3.1 (`frontend/js/vendor/`), changed in one place: a model's parts (embedding, vision encoder, decoder) are read and set up **one after another** instead of all at once. Upstream holds every file in memory at the same moment, about 360 MB for SmolVLM2 500M Fast, on top of the loaded model. `scripts/vendor-transformers.sh` recreates the copy from the official release (it checks the file's SHA-256 before patching).
- **Large photos:** uploaded and camera photos larger than 2048 px on the long side are scaled down once when added (JPEG, quality 0.92), and both models get that copy. Neither loses detail: the local models work at 512 px or less, and OpenAI fits images within 2048 px anyway. A 24 MP phone photo would otherwise decode to about 100 MB, several times over. Runs record the original size (`image_resized`, `image_original_width/height/bytes`); `image_sha256` identifies the original file. VizWiz images are used unchanged.
- **Web Worker:** the model runs in a **background worker**, so the page (log, progress bar, streamed text) stays responsive while it works. If a browser can't use WebGPU inside a worker, the same code runs on the page instead. Each run records which as `local_runtime`.

### 4.2 Test modes
- **Upload Images:** choose or drop one or more photos, or use **Load Sample Image** (a VizWiz photo) or the camera.
  - **One image** runs as a single benchmark. **Several** run one after another as a batch.
  - The **prompt** is sent unchanged to the local and cloud models. The default is "Describe what is in this image for a blind user concisely."
  - **Cloud Baseline / Reference:** `gpt-4o-mini`, `gpt-4o`, or **None**, in which case you type your own reference description to score against.
- **VizWiz Dataset:** runs a random sample (1–200 images) from the VizWiz-Captions validation set, scored against each image's human captions (section 5.3).
  - **Seed:** a seed always picks the same images.
  - **Skip already tested:** avoids images already tested with the same model and precision. It applies only to unseeded (random) batches.

During a batch you get a progress bar, live scores, and **Stop After This Image**. When it finishes, you get a summary and an image-by-image **viewer** with ‹ › arrows.

### 4.3 Results and reports
- **Results & Stats:**
  - **Filters:** filter by label (each batch gets its own) and by device.
  - **Contents:** median latency per model, key findings in plain language, the AI judge's reviews, agreement with human captions, charts, past runs, and detailed tables.
  - **Exports:** **CSV** and **JSON** downloads.
  - **Deleting data:** every deletion asks for confirmation first, and can't be undone.
    - **Selected runs:** tick runs in **Past Runs**, then **Delete Selected**. A single run's report also has **Delete This Run**.
    - **A label or device:** pick it in the filters, then **Manage Data → Delete Runs Matching Filter**.
    - **Everything:** **Manage Data → Clear Entire Database** (you type `DELETE` to confirm). It removes all runs, stored test images, AI judge reviews and diagnostics. The downloaded VizWiz data is kept.
- **Run report:** the test photo, both descriptions, all timings and network measurements, the scores, and run details. Batch runs have ‹ › arrows to the other images in the batch.
- **AI judge:** an OpenAI model (default `gpt-4o`) reviews the latest 10 runs that have both a local and a cloud description, and repeats after every 10 new ones. It sees each photo at low resolution, both descriptions, any human captions and the measured numbers, and writes pros and cons, a verdict and per-run notes. Reviews can be stepped through with ‹ ›; **Review Latest Runs Now** runs one on demand (about 1–2 cents each).
- **Devices:**
  - **Names:** each run stores a device name, set in panel 1; the default is e.g. "iPhone · Safari".
  - **IP addresses:** the client IP is stored too when it's real. With Docker Desktop on Windows, every request appears to come from Docker's internal gateway, so IPs are hidden.

### 4.4 Phones (iPhone)
- **Memory limit:** Safari gives each tab a fixed memory budget, and GPU memory counts against it. Measured on an iPhone 16 Pro (Safari 27):

  | Setup | Download | Result |
  |---|---|---|
  | SmolVLM2 256M Fast | 190 MB | Works |
  | SmolVLM2 256M Balanced (default) | 210 MB | Works (occasionally crashes right after loading) |
  | SmolVLM2 256M CPU only | 265 MB | Works (slower) |
  | SmolVLM2 256M Compatible | 265 MB | Crashes |
  | SmolVLM2 500M Fast | 360 MB | Loaded and warmed up, then crashed about 1 s later (before the one-part-at-a-time loading was added) |
  | SmolVLM2 500M Balanced and larger | 390 MB+ | Crashes |

- **Low-memory mode:** on phones, onnxruntime's pre-reserved memory pools are turned off (`local_low_memory`), and the app warns about GPU presets over about 220 MB.
- **Model switching:** loading a different model reloads the page first, so it starts with clean memory.
- **Focus while busy:** while a model loads or runs, the setup controls in panel 1 are hidden; the log, progress bar and crash banner stay. This keeps the screen simple. It saves very little memory, since the model itself is what fills the tab's budget.
- **Crash recovery:** if Safari kills the tab mid-load or mid-run, the reloaded page loads the model again and retries the same image, or resumes the batch at the image that was running. It gives up after **3 crashes in a row**.
- **Diagnostics:** every step (download, load, warm-up, generation, every 16 tokens) is sent to the backend as it happens, so a crash can be located without developer tools (section 7).

## 5. Metrics and Methodology

Every metric in the app is marked **↓ Lower is better**, **↑ Higher is better**, or *context only*.

### 5.1 Speed (↓ lower is better, except tokens/s ↑)
- **Local:** measured in the browser, **inside the worker that runs the model**.
  - **Time to first token (TTFT):** from the start of the run (image decoding and preprocessing included) to the first generated token.
  - **Total latency:** start to the last token.
  - **Preprocessing:** reported separately.
  - **Tokens per second:** `(output tokens − 1) / (time from first to last token)`.
- **Cloud:** TTFT and total latency are measured on the backend around the streaming OpenAI request. The browser's full round trip (upload included) is recorded separately as `cloud_round_trip_ms`.
- **Generation settings (both sides):** greedy / temperature 0, at most 128 new tokens.
- **Cold starts:** the first run after loading a model without warm-up is flagged and left out of timing stats by default.

### 5.2 Description quality (↑ higher is better)
- **BLEU-4** and **chrF**, implemented to match **sacreBLEU 2.6** exactly (verified against the reference implementation, including multi-reference scoring):
  - **BLEU-4:** 13a tokenization, case-sensitive, exponential smoothing; sentence scores use the effective order.
  - **chrF:** character 6-grams, β = 2, whitespace removed.
- **Corpus scores** sum the n-gram statistics across runs before scoring, like sacreBLEU's `corpus_bleu` / `corpus_chrf`.
- **Local vs cloud:** the local output scored with the cloud output as the reference (the cloud model is the baseline).
- **Word counts** are context only: shorter isn't automatically better, but BLEU-4 penalizes outputs shorter than the reference.

### 5.3 Agreement with human captions (VizWiz)
- **Scoring:** each output is scored against all of the image's usable human captions (multi-reference).
- **Excluded captions:** pre-canned ("Quality issues are too severe to recognize visual content.") and rejected captions, as in the official VizWiz evaluation.
- **Image pool:** only validation images with at least 3 usable captions (6,982 of 7,750).
- **"Local reaches X%":** local corpus score ÷ cloud corpus score on the **same images**.

### 5.4 Privacy and network (↓ lower is better)
- **Local:** while the local model runs, the browser records every network request it makes (worker and page) with the **Resource Timing API** (`local_network_requests`, `local_network_bytes`).
  - Measured value: **0**.
  - The app's own calls to its backend in that window are counted separately: crash-log posts, which carry timing steps and never the image (`local_telemetry_requests`), and other app traffic such as downloading the **next** batch image in advance or live rescoring (`local_app_requests`).
  - Runs saved before `local_app_requests` existed counted those app calls in `local_network_requests`. That's why many batch runs show **1** there: the next-image download, not the model.
- **Cloud:**
  - one outbound request per description to a third party (`cloud_network_requests`, `cloud_destination` = `api.openai.com`);
  - `cloud_request_bytes`: the image plus the prompt, as sent;
  - `cloud_response_bytes`: the streamed response, uncompressed.
- **One-time model download:** downloading the model from Hugging Face happens when the model **loads** (then it's cached), not during inference. It isn't counted in per-run traffic.

### 5.5 AI judge (qualitative)
LLM-as-a-judge reviews follow the approach of Zheng et al. (2023). The judge is an OpenAI model, as is the cloud baseline, so it **may favor the cloud model's style** (self-preference bias). Report it as qualitative support for the metrics, not as a measurement.

### 5.6 Exports
- **CSV:** one row per run, with every measurement: model, precision, file types, runtime, device, timings, tokens, words, network, scores, VizWiz fields, batch ID, device name, and errors.
- **JSON:** all runs, the aggregate stats, and `metricNotes`, which describe each metric as above.

## 6. Data, Storage and API

| Where | What |
|---|---|
| MongoDB `benchmarkRuns` | One document per run (all measurements, outputs, references, scores) |
| MongoDB `judgements` | AI judge reviews |
| MongoDB `clientEvents` | Browser diagnostics timeline (capped at 5 MB, oldest dropped) |
| Volume `app_data` | VizWiz `val.json`, cached VizWiz images, and a copy of each run's test photo (≤ 1024 px) |
| Browser Cache Storage | Downloaded model files (per browser) |

**Main API routes** (all under `/api`):
- **Health and cloud:**
  - `GET /health`: service status;
  - `POST /cloud/describe`: the cloud baseline;
  - `POST /score`: BLEU-4 / chrF for any text.
- **Runs:**
  - `POST /runs/delete`: bulk delete, with body `{ ids }`, `{ label, device }`, or `{ everything: true, confirm: "DELETE" }`;
  - `POST /runs`, `GET /runs`, `GET /runs/:id`, `PATCH /runs/:id`, `DELETE /runs/:id`, `GET /runs/:id/image`;
  - filters: `?label=`, `?device=`, `?batchId=`, `?sort=device`, `?order=asc`.
- **Stats and export:** `GET /stats`, `GET /export?format=csv|json`, `GET /labels`, `GET /devices`.
- **VizWiz data:** `GET /vizwiz/status`, `GET /vizwiz/sample?n=&seed=`, `GET /vizwiz/images/:file`.
- **AI judge:** `GET /judgements`, `POST /judgements`.
- **Diagnostics:** `GET /diagnostics?session=`, `POST /diagnostics`.

## 7. Troubleshooting
- **The iPhone can't connect:** allow ports 80 and 443 through Windows Firewall (administrator PowerShell):
  ```powershell
  New-NetFirewallRule -DisplayName "WebGPU SLM Benchmark" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
  ```
- **The PC's IP changed:** re-run `./scripts/make-local-cert.sh`, update `CORS_ORIGIN` in `prod.env`, and restart prod. A DHCP reservation on the router keeps the IP fixed.
- **"Connection isn't private" on the iPhone:** turn on the trust switch (section 3, step 3), or check that the certificate includes the address you used:
  ```bash
  openssl x509 -in certs/server.crt -noout -ext subjectAltName
  ```
- **"WebGPU needs a secure connection":** the page was opened over plain http from another device. Use `https://<PC-IP>` in prod mode.
- **The page crashes on the phone:** after the reload, the banner shows the step where it stopped. For the full timeline, run:
  ```bash
  docker compose --env-file prod.env logs backend | grep "\[client"
  ```
  or open `https://<PC-IP>/api/diagnostics`.
- **"The model produced no text":** the model output only special tokens (seen with Fast precision on Safari). Use Balanced.
- **Backend says `OPENAI_API_KEY` is not set:** create `secrets.env` (section 2.3), then `docker compose up -d backend`.

## 8. Sources and References

### Dataset
- **VizWiz-Captions** (images and human captions): <https://vizwiz.org/tasks-and-datasets/image-captioning/>. Licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  - D. Gurari, Y. Zhao, M. Zhang, N. Bhattacharya. *Captioning Images Taken by People Who Are Blind.* ECCV 2020. <https://arxiv.org/abs/2002.08565>
  - Official evaluation code: <https://github.com/Yinan-Zhao/vizwiz-caption>

### Local models
- **SmolVLM2 256M / 500M** (Hugging Face): <https://huggingface.co/HuggingFaceTB/SmolVLM2-256M-Video-Instruct>, <https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct>
  - A. Marafioti et al. *SmolVLM: Redefining small and efficient multimodal models.* 2025. <https://arxiv.org/abs/2504.05299>
- **Janus-Pro 1B** (DeepSeek):
  - original <https://huggingface.co/deepseek-ai/Janus-Pro-1B>;
  - browser (ONNX) version <https://huggingface.co/onnx-community/Janus-Pro-1B-ONNX>.
  - X. Chen et al. *Janus-Pro: Unified Multimodal Understanding and Generation with Data and Model Scaling.* 2025. <https://arxiv.org/abs/2501.17811>
- **Qwen3.5 2B** (Alibaba Qwen):
  - original <https://huggingface.co/Qwen/Qwen3.5-2B>;
  - browser (ONNX) version <https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX-OPT>.

### Cloud models (OpenAI)
- GPT-4o mini: <https://platform.openai.com/docs/models/gpt-4o-mini>
- GPT-4o (also the default AI judge): <https://platform.openai.com/docs/models/gpt-4o>
- Images and vision input: <https://platform.openai.com/docs/guides/images-vision>
- Chat Completions API: <https://platform.openai.com/docs/api-reference/chat>
- Streaming responses: <https://platform.openai.com/docs/guides/streaming-responses>
- OpenAI Node.js library: <https://github.com/openai/openai-node>

### In-browser inference
- Transformers.js (v4.3.1; the app serves a pinned copy of the official `dist/transformers.min.js` with one change, see section 4.1):
  - documentation <https://huggingface.co/docs/transformers.js>;
  - WebGPU guide <https://huggingface.co/docs/transformers.js/guides/webgpu>;
  - source <https://github.com/huggingface/transformers.js>;
  - CDN <https://jsdelivr.com/package/npm/@huggingface/transformers>.
- ONNX Runtime Web:
  - <https://onnxruntime.ai/docs/tutorials/web/>;
  - WebGPU execution provider <https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html>.

### Metrics
- BLEU: K. Papineni et al. *BLEU: a Method for Automatic Evaluation of Machine Translation.* ACL 2002. <https://aclanthology.org/P02-1040/>
- chrF: M. Popović. *chrF: character n-gram F-score for automatic MT evaluation.* WMT 2015. <https://aclanthology.org/W15-3049/>
- sacreBLEU: M. Post. *A Call for Clarity in Reporting BLEU Scores.* WMT 2018. <https://aclanthology.org/W18-6319/>. Reference implementation: <https://github.com/mjpost/sacrebleu>.
- LLM-as-a-judge: L. Zheng et al. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* NeurIPS 2023. <https://arxiv.org/abs/2306.05685>

### Web platform
- WebGPU:
  - specification <https://www.w3.org/TR/webgpu/>;
  - MDN guide <https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API>.
- Secure contexts (why https is needed): <https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts>
- Web Workers: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API>
- Resource Timing (network measurement): <https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Resource_timing>
- Cache API (model and image caching): <https://developer.mozilla.org/en-US/docs/Web/API/Cache>
- Screen Wake Lock (keeps the phone awake during batches): <https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API>

### Certificates and iOS
- Apple: *Requirements for trusted certificates in iOS 13 and macOS 10.15*: <https://support.apple.com/en-us/103769>
- Apple: *Trust manually installed certificate profiles in iOS, iPadOS, and visionOS*: <https://support.apple.com/en-us/102390>
- OpenSSL X.509 v3 extensions (name constraints, subject alternative names): <https://docs.openssl.org/master/man5/x509v3_config/>

### Infrastructure
- Docker Compose:
  - <https://docs.docker.com/compose/>;
  - environment variables <https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/>.
- nginx: <https://nginx.org/en/docs/>
- Express: <https://expressjs.com/>
- Mongoose: <https://mongoosejs.com/>
- MongoDB capped collections (diagnostics log): <https://www.mongodb.com/docs/manual/core/capped-collections/>
- adm-zip (extracting the VizWiz annotations): <https://github.com/cthackers/adm-zip>
