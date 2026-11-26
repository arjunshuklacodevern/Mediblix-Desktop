import aiRouter from "../services/ai/aiRouter.js";

const parseInvoice = async (req, res) => {
  const { fileData, mimeType, files } = req.body;

  if ((!fileData || !mimeType) && (!files || !Array.isArray(files))) {
    return res.status(400).json({ message: "File data or files array is required" });
  }

  try {
    const result = await aiRouter.routeDocumentParsing({ fileData, mimeType, files }, "invoice");

    if (result.success) {
      return res.json(result.data);
    }

    if (result.isOfflineFallback) {
      return res.status(503).json({
        message: result.message,
        mode: result.mode,
        fallbackOption: result.fallbackOption,
      });
    }

    return res.status(500).json({ message: result.message || "Failed to parse invoice" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const parseBill = async (req, res) => {
  const { fileData, mimeType, files } = req.body;

  if ((!fileData || !mimeType) && (!files || !Array.isArray(files))) {
    return res.status(400).json({ message: "File data or files array is required" });
  }

  try {
    const result = await aiRouter.routeDocumentParsing({ fileData, mimeType, files }, "bill");

    if (result.success) {
      return res.json(result.data);
    }

    if (result.isOfflineFallback) {
      return res.status(503).json({
        message: result.message,
        mode: result.mode,
        fallbackOption: result.fallbackOption,
      });
    }

    return res.status(500).json({ message: result.message || "Failed to parse sales bill" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export { parseInvoice, parseBill };
