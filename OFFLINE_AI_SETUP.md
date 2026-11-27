# Mediblix Desktop — Offline AI Setup

This guide explains how to prepare Mediblix Desktop's local AI features to work without an internet connection.

## 1. Requirements

- Node.js and npm
- Ollama
- Sufficient free disk space for the AI models
- Internet access during initial setup and model downloads

## 2. Install project dependencies

From the project root:

```bash
npm install
```

Install backend dependencies:

```bash
cd backend
npm install
cd ..
```

## 3. Install Ollama

Download Ollama from the official website:

https://ollama.com/download

Supported setup targets:

| Platform | Runtime status in this branch |
|---|---|
| macOS Apple Silicon (M1–M4) | ARM64 binary included |
| Windows x64 | Ollama must be installed separately |
| Intel macOS | Not yet verified |

**Note:** The bundled Ollama binary currently committed to this branch is macOS ARM64 only. Do not use it on Windows or Intel Macs.

## 4. Download AI models

Install and start Ollama, then download the approved models:

```bash
ollama pull llama3.2:3b
ollama pull qwen2.5vl:7b
```

Verify that both models are available:

```bash
ollama list
```

Expected models:

- `llama3.2:3b` — local MedAgent chat.
- `qwen2.5vl:7b` — visual understanding for invoice and bill processing.

Model downloads are not included in the Git branch. Each computer must obtain them separately.

## 5. Prepare Whisper speech recognition

Mediblix uses `Xenova/whisper-base` through Transformers.js for local speech-to-text.

Before disconnecting from the internet:

1. Start Mediblix while internet access is available.
2. Open and exercise the audio transcription feature.
3. Allow the Whisper model to download completely.
4. Confirm that the model is cached locally.
5. Test transcription before going offline.

The packaging verification script currently checks for Whisper artifacts under:

```text
backend/node_modules/@xenova/transformers/.cache/Xenova/whisper-base
```

The actual runtime cache location must also be verified against the application's Transformers.js configuration.

## 6. Run Mediblix

Start the application using the project's normal development instructions.

Verify that:

- Ollama starts successfully.
- Both required models are detected.
- MedAgent chat responds.
- Invoice and purchase import works.
- Bill parsing works.
- Audio transcription works.

## 7. Test genuine offline operation

After all models have been downloaded:

1. Close Mediblix.
2. Disconnect the computer from the internet.
3. Start Mediblix again.
4. Test each AI feature independently.
5. Confirm that no feature requires a cloud API or internet connection.

A successful online test does not prove offline functionality.

## 8. Important limitations

- AI model weights are not committed to this repository.
- The Windows Ollama runtime is not included in this branch.
- The current bundled Ollama executable is for macOS ARM64.
- Whisper must be downloaded and cached before offline use.
- Packaging verification must be run on a machine with the expected local models and runtime assets.

## 9. Useful verification commands

Check Ollama:

```bash
ollama --version
ollama list
```

Check the bundled macOS runtime:

```bash
ls -lh build/bin/ollama
file build/bin/ollama
```

Run offline AI tests:

```bash
npm run test:ai-offline
```

Run packaging verification:

```bash
node scripts/package_offline_bundle.js
```

**Important:** Packaging verification depends on local runtime and model files. A failed check may mean the local setup is incomplete; it does not necessarily mean the application code is broken.

---

**Current status:** This branch contains offline AI implementation code and a macOS ARM64 Ollama binary. It is not yet a complete zero-setup, cross-platform offline distribution.