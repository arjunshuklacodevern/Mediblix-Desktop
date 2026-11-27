/**
 * Mediblix Desktop — Audio Transcription (Whisper) Test
 */

import { transcribeAudioLocally } from "../services/localAIService.js";
import wavefilePkg from "wavefile";
const WaveFile = wavefilePkg.WaveFile || wavefilePkg;

async function testAudio() {
  console.log("=== Testing Local Whisper STT ===");
  // Generate a 1-second 16kHz mono audio WAV buffer
  const wav = new WaveFile();
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.2;
  }
  wav.fromScratch(1, 16000, "32f", samples);
  const buffer = Buffer.from(wav.toBuffer());

  try {
    const text = await transcribeAudioLocally(buffer, "audio/wav");
    console.log("✓ Whisper STT pipeline executed successfully without crashing.");
    console.log("Transcribed text:", JSON.stringify(text));
  } catch (err) {
    console.error("Whisper test error:", err.message);
    process.exit(1);
  }
}

testAudio();
