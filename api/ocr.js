const { processReceiptImage } = require("../lib/receipt-ocr-service");

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readRawBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const result = await processReceiptImage({ imageDataUrl: payload.imageDataUrl || "" });
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message || "Receipt OCR failed.",
      provider: "Google Document AI Expense Parser",
    });
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 12_000_000) {
        reject(new Error("Upload is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
