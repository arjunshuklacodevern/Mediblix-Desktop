/**
 * Online AI Engine — AWS Cloud Gateway & AI Provider Integration
 *
 * Implements:
 *  - Secure communication via centralized AWS API Gateway / Lambda
 *  - Fallback to direct cloud AI provider (Gemini) when AWS gateway is not yet deployed
 *  - HTTPS enforcement, request validation, bounded timeouts (AbortController)
 *  - Minimal payload transmission (privacy & bandwidth preservation)
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Checks whether online cloud AI capabilities are configured and likely reachable.
 */
export const getOnlineConfig = () => {
  const awsGatewayUrl = process.env.AWS_AI_GATEWAY_URL;
  const awsApiKey = process.env.AWS_AI_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (awsGatewayUrl) {
    return {
      provider: "aws-gateway",
      gatewayUrl: awsGatewayUrl,
      apiKey: awsApiKey || null,
      isConfigured: true,
    };
  }

  if (geminiApiKey) {
    return {
      provider: "gemini-cloud",
      apiKey: geminiApiKey,
      isConfigured: true,
    };
  }

  return {
    provider: "none",
    isConfigured: false,
  };
};

/**
 * Executes a call with an explicit timeout using AbortController
 */
const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
};

/**
 * Dispatches an AI prompt request to the AWS AI Gateway
 */
const callAwsGateway = async (gatewayUrl, apiKey, payload, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetchWithTimeout(
    gatewayUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    timeoutMs
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AWS AI Gateway responded with HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data;
};

/**
 * Dispatches an AI request directly to Gemini (fallback when AWS Gateway is not yet deployed)
 */
const callDirectGemini = async (apiKey, prompt, systemPrompt = "", timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const parts = [];
  if (systemPrompt) {
    parts.push({ text: systemPrompt });
  }
  parts.push({ text: prompt });

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    },
    timeoutMs
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "Gemini Cloud API error");
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Empty response received from Cloud AI provider");
  }

  return text;
};

/**
 * Unified Cloud AI Request Runner
 */
export const callCloudAi = async ({ prompt, systemPrompt = "", action = "chat", extraPayload = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  const config = getOnlineConfig();

  if (!config.isConfigured) {
    throw new Error("No Cloud AI provider or AWS Gateway configured in environment");
  }

  if (config.provider === "aws-gateway") {
    // Send minimal request to AWS Gateway
    const gatewayPayload = {
      action,
      prompt,
      systemPrompt,
      ...extraPayload,
    };
    const result = await callAwsGateway(config.gatewayUrl, config.apiKey, gatewayPayload, timeoutMs);
    return {
      text: typeof result === "string" ? result : result.text || result.content || JSON.stringify(result),
      provider: "aws-gateway",
      raw: result,
    };
  }

  // Direct Gemini fallback
  const text = await callDirectGemini(config.apiKey, prompt, systemPrompt, timeoutMs);
  return {
    text,
    provider: "gemini-cloud",
  };
};

/**
 * Cloud Document Parser (Invoice / Bill OCR)
 */
export const parseDocumentCloud = async ({ files, fileData, mimeType, documentType = "invoice", timeoutMs = 15000 }) => {
  const config = getOnlineConfig();

  if (!config.isConfigured) {
    throw new Error("Cloud AI Gateway is not configured for document parsing");
  }

  // Build minimal parts
  const parts = [];
  if (files && Array.isArray(files) && files.length > 0) {
    for (const file of files) {
      if (file.fileData && file.mimeType) {
        parts.push({
          inlineData: {
            mimeType: file.mimeType.split(";")[0].trim(),
            data: file.fileData,
          },
        });
      }
    }
  } else if (fileData && mimeType) {
    parts.push({
      inlineData: {
        mimeType: mimeType.split(";")[0].trim(),
        data: fileData,
      },
    });
  }

  if (parts.length === 0) {
    throw new Error("No readable file parts found in request payload");
  }

  const instructionText =
    documentType === "invoice"
      ? "You are an expert pharmaceutical invoice parser. Extract all medicine product items listed in this document or audio. Output a JSON array of items: [{ name (string), sku (string, batch number), category (string), quantity (number), price (number), expiryDate (YYYY-MM-DD or null), mfgDate (YYYY-MM-DD or null), hsn (string or null), packaging (string, default '10 Tablets / Strip'), tabletsPerStrip (number, default 10) }]. Only return a raw JSON array."
      : "You are an expert sales bill and customer invoice parser. Extract customer details and medicine items. Output a JSON object: { customerName (string or null), customerMobile (string or null), items: [{ name (string), sku (string, batch number), quantity (number), price (number), unit (string, default 'Tablet') }] }. Only return a raw JSON object.";

  parts.push({ text: instructionText });

  if (config.provider === "aws-gateway") {
    const payload = {
      action: documentType === "invoice" ? "parse-invoice" : "parse-bill",
      parts,
    };
    const response = await callAwsGateway(config.gatewayUrl, config.apiKey, payload, timeoutMs);
    return response;
  }

  // Direct Gemini call
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    },
    timeoutMs
  );

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "Failed to process document with Cloud AI");
  }

  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResponse) {
    throw new Error("No data could be extracted by Cloud AI");
  }

  return { text: textResponse, provider: "gemini-cloud" };
};

export default {
  getOnlineConfig,
  callCloudAi,
  parseDocumentCloud,
};
