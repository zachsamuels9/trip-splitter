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
    const imageDataUrl = payload.imageDataUrl || "";
    const imageBase64 = imageDataUrl.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (!imageBase64) {
      res.status(400).json({ error: "Receipt image is required." });
      return;
    }

    const result = await readWithGoogleVision(imageBase64).catch(() => readWithOcrSpace(imageDataUrl));
    const text = result.text;
    if (!text) {
      res.status(422).json({ error: "OCR did not return text." });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "OCR failed." });
  }
};

async function readWithGoogleVision(imageBase64) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_VISION_API_KEY is not configured.");
  const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content: imageBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["en"] },
        },
      ],
    }),
  });
  if (!response.ok) throw new Error("Google Vision OCR failed.");
  const data = await response.json();
  const result = data.responses?.[0];
  if (result?.error) throw new Error(result.error.message || "Google Vision OCR failed.");
  return { provider: "Google Vision", text: result?.fullTextAnnotation?.text || result?.textAnnotations?.[0]?.description || "" };
}

async function readWithOcrSpace(imageDataUrl) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) throw new Error("OCR_SPACE_API_KEY is not configured.");
  const formData = new FormData();
  formData.append("base64Image", imageDataUrl);
  formData.append("language", "eng");
  formData.append("OCREngine", "2");
  formData.append("isOverlayRequired", "false");
  formData.append("scale", "true");
  formData.append("detectOrientation", "true");
  formData.append("isTable", "true");

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey },
    body: formData,
  });
  if (!response.ok) throw new Error("OCR.Space request failed.");
  const data = await response.json();
  if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage || "OCR.Space processing failed.");
  return { provider: "OCR.Space", text: data.ParsedResults?.map((result) => result.ParsedText).filter(Boolean).join("\n").trim() || "" };
}

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
