/**
 * Mediblix Desktop — Gemini (online) AI service
 *
 * This is the existing online implementation extracted from the controllers.
 * Behaviour (endpoint, model, payload shape) is unchanged; what is new is:
 *   - one place that talks to Gemini,
 *   - typed errors so a missing key, an auth failure, quota exhaustion and a
 *     network failure are distinguishable,
 *   - request timeouts,
 *   - no secrets or document payloads in logs.
 */

import { AI_ERROR, AIError, toAIError } from "./aiErrors.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 45000;

export function getModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

export function isConfigured() {
  return Boolean((process.env.GEMINI_API_KEY || "").trim());
}

export function buildParts(entries = [], prompt) {
  const parts = entries.map((entry) => ({
    inlineData: {
      mimeType: entry.mimeType,
      data: entry.base64,
    },
  }));

  if (prompt) parts.push({ text: prompt });
  return parts;
}

/**
 * Calls Gemini generateContent and returns the first text part.
 *
 * @param {{ parts: Array, timeoutMs?: number }} params
 * @returns {Promise<{ text: string, model: string, provider: 'gemini' }>}
 */
export async function generateContent({ parts, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();

  if (!apiKey) {
    throw new AIError(
      AI_ERROR.GEMINI_NOT_CONFIGURED,
      "Gemini is not configured on this installation (GEMINI_API_KEY is missing).",
      { provider: "gemini" }
    );
  }

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new AIError(AI_ERROR.INPUT_REQUIRED, "No content was supplied to the AI service.", {
      provider: "gemini",
    });
  }

  const model = getModel();
  let response;

  try {
    response = await fetch(`${API_ROOT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AIError(
        AI_ERROR.TIMEOUT,
        `Gemini did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
        { provider: "gemini", retryable: true, cause: error }
      );
    }
    const code = error?.cause?.code || error?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ECONNRESET") {
      throw new AIError(
        AI_ERROR.OFFLINE,
        "No internet connection could be reached for Gemini.",
        { provider: "gemini", details: { networkCode: code }, cause: error }
      );
    }
    throw toAIError(error, AI_ERROR.GEMINI_UNAVAILABLE);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = data?.error || {};
    const apiMessage = String(apiError.message || `Gemini responded with HTTP ${response.status}`);
    const httpStatus = Number(apiError.code || response.status);

    if (httpStatus === 401 || httpStatus === 403 || /api key|permission|credential/i.test(apiMessage)) {
      throw new AIError(
        AI_ERROR.GEMINI_AUTH,
        "Gemini rejected the configured API key. Check GEMINI_API_KEY, or use offline AI.",
        { provider: "gemini", details: { httpStatus } }
      );
    }
    if (httpStatus === 429 || /quota|rate limit|resource_exhausted/i.test(apiMessage)) {
      throw new AIError(
        AI_ERROR.GEMINI_QUOTA,
        "The Gemini API quota or rate limit has been reached. Try again later, or use offline AI.",
        { provider: "gemini", retryable: true, details: { httpStatus } }
      );
    }
    if (httpStatus >= 500) {
      throw new AIError(
        AI_ERROR.GEMINI_UNAVAILABLE,
        "Gemini is temporarily unavailable (server error).",
        { provider: "gemini", retryable: true, details: { httpStatus } }
      );
    }
    throw new AIError(AI_ERROR.GEMINI_UNAVAILABLE, apiMessage, {
      provider: "gemini",
      details: { httpStatus },
    });
  }

  const blockReason = data?.promptFeedback?.blockReason;
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new AIError(
      AI_ERROR.GEMINI_EMPTY,
      blockReason
        ? `Gemini blocked this request (${blockReason}). Please review the document.`
        : "Gemini returned no content for this document.",
      { provider: "gemini", details: blockReason ? { blockReason } : null }
    );
  }

  return { text, model, provider: "gemini" };
}

export default { getModel, isConfigured, buildParts, generateContent };
