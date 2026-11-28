import api from "./api";

// Local vision extraction can take a minute on first load, so parsing gets a
// generous timeout. Provider selection and health have their own short budgets.
const PARSE_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 15000;

const emitProviderEvent = (response) => {
  if (typeof window === "undefined") return;
  const provider = response.headers?.["x-mediblix-ai-provider"];
  if (!provider) return;

  window.dispatchEvent(
    new CustomEvent("Mediblix:ai_provider", {
      detail: {
        provider,
        model: response.headers["x-mediblix-ai-model"] || null,
        fallback: response.headers["x-mediblix-ai-fallback"] || null,
      },
    })
  );
};

const parseInvoice = async (fileDataOrPayload, mimeType) => {
  const body = typeof fileDataOrPayload === "object" && fileDataOrPayload.files
    ? { files: fileDataOrPayload.files }
    : { fileData: fileDataOrPayload, mimeType };
  const response = await api.post("/ai/parse-invoice", body, { timeout: PARSE_TIMEOUT_MS });
  emitProviderEvent(response);
  return response.data;
};

const parseBill = async (fileDataOrPayload, mimeType) => {
  const body = typeof fileDataOrPayload === "object" && fileDataOrPayload.files
    ? { files: fileDataOrPayload.files }
    : { fileData: fileDataOrPayload, mimeType };
  const response = await api.post("/ai/parse-bill", body, { timeout: PARSE_TIMEOUT_MS });
  emitProviderEvent(response);
  return response.data;
};

/**
 * Reports which AI providers are usable right now.
 * `probe: true` additionally runs one local token to prove inference works.
 */
const getAIStatus = async ({ probe = false } = {}) => {
  const response = await api.get("/ai/status", {
    params: probe ? { probe: 1 } : {},
    timeout: probe ? 120000 : STATUS_TIMEOUT_MS,
  });
  return response.data;
};

const authHeaders = () => {
  const headers = { "Content-Type": "application/json" };
  try {
    const userInfo = JSON.parse(localStorage.getItem("userInfo") || "null");
    if (userInfo?.token) headers.Authorization = `Bearer ${userInfo.token}`;
    if (userInfo?.organization?._id) headers["x-organization-id"] = userInfo.organization._id;
  } catch {
    // Ignore malformed local storage; the request will fail with 401 instead.
  }
  const deviceSession = localStorage.getItem("active_device_session");
  if (deviceSession) headers["x-device-session"] = deviceSession;
  return headers;
};

/**
 * Streams offline model download progress as NDJSON.
 * @param {'text'|'vision'} kind which offline model to download
 * @param {(progress: {phase: string, percent: number|null}) => void} onProgress
 */
const installModel = async (kind, onProgress) => {
  const baseURL = api.defaults.baseURL || "/api";
  const response = await fetch(`${baseURL}/ai/install-model`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ kind }),
  });

  if (!response.ok) {
    let message = `Model download failed (HTTP ${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.message) message = payload.message;
    } catch {
      // Keep the default message.
    }
    throw new Error(message);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("This browser could not read the download stream.");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type === "error") throw new Error(event.message || "Model download failed.");
      if (event.type === "progress") onProgress?.(event);
      if (event.type === "done") onProgress?.({ status: "done", percent: 100 });
    }
  }

  return { kind, installed: true };
};

export default {
  parseInvoice,
  parseBill,
  getAIStatus,
  installModel,
};
