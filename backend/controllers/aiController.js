import { parseDocumentAI, getActiveProvider, setActiveProvider, checkOllamaHealth } from "../services/aiProvider.js";

const INVOICE_EXTRACTION_PROMPT =
  "You are an expert pharmaceutical invoice and purchase sheet parser. Extract all medicine product items listed in this document or mentioned in this audio recording. Output a JSON array of items, where each item contains exactly these fields: name (string), sku (string, representing the batch number. Extract the batch number or generate a unique code if missing, e.g. BAT-101), category (string), quantity (number), price (number), expiryDate (string, YYYY-MM-DD or null), mfgDate (string, YYYY-MM-DD or null, representing the manufacturing date), hsn (string or null, representing the HSN tax code), packaging (string, default '10 Tablets / Strip'), tabletsPerStrip (number, default 10). Generate clean batch numbers for sku if they are missing or invalid. Categorize them logically (e.g., Analgesics, Antibiotics, Diabetes, Cardiology, Vitamins, Antacids, Antivirals). Only return a raw JSON array inside the text block. If no products can be found, return an empty JSON array: []. Do not include markdown code block characters or any explaining text.";

const BILL_EXTRACTION_PROMPT =
  "You are an expert sales sales bill and customer invoice parser. Extract the customer information and the pharmaceutical product items listed in this document or mentioned in this audio recording. Output a JSON object containing exactly these keys: customerName (string or null), customerMobile (string containing 10-digit mobile number or null), items (array of objects where each object has: name (string), sku (string, representing the batch number. Extract the batch number or generate a unique code if missing, e.g. BAT-101), quantity (number), price (number), unit (string, default 'Tablet')). Generate clean batch numbers for sku if they are missing or invalid. Only return a raw JSON object. Do not include markdown code block characters or any explaining text.";

const parseInvoice = async (req, res) => {
  const { fileData, mimeType, files } = req.body;

  if ((!fileData || !mimeType) && (!files || !Array.isArray(files))) {
    return res.status(400).json({ message: "File data or files array is required" });
  }

  try {
    let targetFileData = fileData;
    let targetMimeType = mimeType;

    if (files && Array.isArray(files) && files.length > 0) {
      targetFileData = files[0].fileData;
      targetMimeType = files[0].mimeType;
    }

    const items = await parseDocumentAI({
      fileData: targetFileData,
      mimeType: targetMimeType,
      prompt: INVOICE_EXTRACTION_PROMPT,
      isInvoice: true,
    });

    if (!Array.isArray(items)) {
      return res.status(422).json({
        message: "AI response was not in a valid format. Please ensure the document contains a clear product list.",
      });
    }

    res.json(items);
  } catch (error) {
    console.error("parseInvoice Error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

const parseBill = async (req, res) => {
  const { fileData, mimeType, files } = req.body;

  if ((!fileData || !mimeType) && (!files || !Array.isArray(files))) {
    return res.status(400).json({ message: "File data or files array is required" });
  }

  try {
    let targetFileData = fileData;
    let targetMimeType = mimeType;

    if (files && Array.isArray(files) && files.length > 0) {
      targetFileData = files[0].fileData;
      targetMimeType = files[0].mimeType;
    }

    const billData = await parseDocumentAI({
      fileData: targetFileData,
      mimeType: targetMimeType,
      prompt: BILL_EXTRACTION_PROMPT,
      isInvoice: false,
    });

    if (!billData || typeof billData !== "object" || !Array.isArray(billData.items)) {
      return res.status(422).json({
        message: "AI response was not in a valid format. Please ensure the document is readable or the audio is clear.",
      });
    }

    res.json(billData);
  } catch (error) {
    console.error("parseBill Error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET /api/ai/status
 * Returns current provider ('local' | 'cloud') and local inference engine status
 */
const getAIStatus = async (req, res) => {
  try {
    const provider = getActiveProvider();
    const ollamaStatus = await checkOllamaHealth();
    res.json({
      provider,
      isOfflineOnly: provider === "local",
      cloudConfigured: Boolean(process.env.GEMINI_API_KEY),
      localRuntime: {
        engine: "Ollama + Transformers.js",
        ...ollamaStatus,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/ai/provider
 * Switch active provider explicitly ('local' | 'cloud')
 */
const updateAIProvider = async (req, res) => {
  const { provider } = req.body;
  try {
    const updated = setActiveProvider(provider);
    res.json({
      provider: updated,
      message: `AI provider successfully switched to ${updated}`,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export { parseInvoice, parseBill, getAIStatus, updateAIProvider };
