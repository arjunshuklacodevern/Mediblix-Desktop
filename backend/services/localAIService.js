/**
 * Mediblix Desktop — Local AI Inference Service
 *
 * Provides 100% offline local inference via:
 * 1. Ollama (Llama 3.2 3B for text/reasoning & Qwen2.5-VL 7B for vision/OCR)
 * 2. Transformers.js ONNX (Whisper for audio voice dictation)
 * 3. PDF parsing (pdf-parse for text PDFs, pdf-to-png-converter for scanned PDFs)
 *
 * ZERO cloud or internet dependencies.
 */

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;

export const DEFAULT_TEXT_MODEL = process.env.MEDIBLIX_LOCAL_TEXT_MODEL || "llama3.2:3b";
export const DEFAULT_VISION_MODEL = process.env.MEDIBLIX_LOCAL_VISION_MODEL || "qwen2.5vl:7b";

/**
 * Check if local Ollama daemon is reachable and list downloaded models
 */
export async function checkOllamaHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/tags",
        method: "GET",
        timeout: 3000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map((m) => m.name);
            resolve({
              running: true,
              models,
              hasTextModel: models.some((m) => m.includes(DEFAULT_TEXT_MODEL.split(":")[0])),
              hasVisionModel: models.some((m) => m.includes(DEFAULT_VISION_MODEL.split(":")[0])),
            });
          } catch (e) {
            resolve({ running: false, error: "Invalid JSON from Ollama", models: [] });
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve({ running: false, error: err.message, models: [] });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ running: false, error: "Connection timed out", models: [] });
    });
    req.end();
  });
}

/**
 * Execute text chat/generation via Ollama
 */
export async function callLocalLLM(prompt, systemPrompt = "", model = DEFAULT_TEXT_MODEL, options = {}) {
  const payload = {
    model,
    messages: [],
    stream: false,
    options: {
      temperature: options.temperature ?? 0.1,
      num_predict: options.num_predict ?? 2048,
    },
  };

  if (systemPrompt) {
    payload.messages.push({ role: "system", content: systemPrompt });
  }
  payload.messages.push({ role: "user", content: prompt });

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
        timeout: 60000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`Ollama HTTP ${res.statusCode}: ${raw}`));
            }
            const data = JSON.parse(raw);
            const content = data.message?.content || "";
            resolve(content);
          } catch (err) {
            reject(new Error(`Failed to parse Ollama response: ${err.message}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Local AI connection error (is Ollama running?): ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Local AI inference timed out after 60s"));
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Execute multimodal vision extraction via Ollama (e.g. Qwen2.5-VL 7B)
 */
export async function callLocalVision(imageBase64, prompt, model = DEFAULT_VISION_MODEL) {
  const cleanBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [cleanBase64],
      },
    ],
    stream: false,
    options: {
      temperature: 0.0,
      num_predict: 2048,
    },
  };

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
        timeout: 120000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`Ollama Vision HTTP ${res.statusCode}: ${raw}`));
            }
            const data = JSON.parse(raw);
            const content = data.message?.content || "";
            resolve(content);
          } catch (err) {
            reject(new Error(`Failed to parse Ollama vision response: ${err.message}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Local Vision AI connection error: ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Local Vision AI inference timed out after 120s"));
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Parse PDF content locally:
 * 1. Tries direct text extraction via pdf-parse
 * 2. If scanned/no text, renders pages to PNG buffers via pdf-to-png-converter
 */
export async function extractFromPdf(pdfBuffer) {
  let text = "";
  try {
    const { createRequire } = await import("module");
    const req = createRequire(import.meta.url);
    const pdfPkg = req("pdf-parse");
    const ParserClass = pdfPkg.PDFParse || (typeof pdfPkg === "function" ? pdfPkg : null);
    if (ParserClass) {
      try {
        const parser = new ParserClass({ data: pdfBuffer });
        const result = await parser.getText();
        if (result && result.text && result.text.trim().length > 10) {
          return { type: "text", text: result.text.trim() };
        }
      } catch (classErr) {
        if (typeof pdfPkg === "function") {
          const parsed = await pdfPkg(pdfBuffer);
          if (parsed && parsed.text && parsed.text.trim().length > 10) {
            return { type: "text", text: parsed.text.trim() };
          }
        }
      }
    }
  } catch (err) {
    console.warn("[LocalAI] pdf-parse extraction error:", err.message);
  }

  // Fallback to page rendering for scanned/image PDFs
  try {
    const { pdfToPng } = await import("pdf-to-png-converter");
    const tmpDir = os.tmpdir();
    const tmpPdf = path.join(tmpDir, `mediblix_scan_${Date.now()}.pdf`);
    fs.writeFileSync(tmpPdf, pdfBuffer);

    const pngPages = await pdfToPng(tmpPdf, {
      viewportScale: 1.5,
    });

    try {
      fs.unlinkSync(tmpPdf);
    } catch (_) {}

    if (pngPages && pngPages.length > 0) {
      const pageImages = pngPages.map((p) => p.content.toString("base64"));
      return { type: "images", images: pageImages };
    }
  } catch (err) {
    console.warn("[LocalAI] PDF to image rendering error:", err.message);
  }

  return { type: "empty", text: "" };
}

/**
 * Local Speech-To-Text using Transformers.js ONNX (Whisper)
 */
let whisperPipelineInstance = null;

export async function transcribeAudioLocally(audioBuffer, mimeType = "audio/webm") {
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
    if (process.env.MEDIBLIX_WHISPER_CACHE_DIR) {
      env.cacheDir = process.env.MEDIBLIX_WHISPER_CACHE_DIR;
    }
    if (!whisperPipelineInstance) {
      whisperPipelineInstance = await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-base",
        { quantized: true }
      );
    }

    // Convert audio buffer into normalized Float32Array PCM
    // If incoming audio is WebM or compressed, we extract raw PCM
    let audioData = null;

    try {
      const { default: wavefilePkg } = await import("wavefile");
      const WaveFile = wavefilePkg.WaveFile || wavefilePkg;
      const wav = new WaveFile(audioBuffer);
      wav.toBitDepth("32f");
      wav.toSampleRate(16000);
      let samples = wav.getSamples();
      if (Array.isArray(samples)) {
        samples = samples[0];
      }
      audioData = Float32Array.from(samples);
    } catch (_) {
      // Direct raw float array conversion fallback
      const float32 = new Float32Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset,
        Math.floor(audioBuffer.byteLength / 4)
      );
      audioData = float32;
    }

    const output = await whisperPipelineInstance(audioData, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "english",
      task: "transcribe",
    });

    return output.text || "";
  } catch (err) {
    console.error("[LocalAI] Whisper STT error:", err.message);
    throw new Error(`Local speech-to-text failed: ${err.message}`);
  }
}

export default {
  checkOllamaHealth,
  callLocalLLM,
  callLocalVision,
  extractFromPdf,
  transcribeAudioLocally,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
};
