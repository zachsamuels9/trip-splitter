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

    const mimeType = imageDataUrl.match(/^data:([^;]+)/i)?.[1] || "image/jpeg";
    const result = await readWithDocumentAi(imageBase64, mimeType)
      .catch(() => readWithGoogleVision(imageBase64))
      .catch(() => readWithOcrSpace(imageDataUrl));
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

async function readWithDocumentAi(imageBase64, mimeType) {
  const projectId = process.env.GOOGLE_DOCUMENT_AI_PROJECT_ID;
  const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION || "us";
  const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
  if (!projectId || !processorId) throw new Error("Google Document AI is not configured.");

  const accessToken = await documentAiAccessToken();
  const response = await fetch(
    `https://${location}-documentai.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/processors/${encodeURIComponent(processorId)}:process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rawDocument: {
          content: imageBase64,
          mimeType,
        },
      }),
    }
  );
  if (!response.ok) throw new Error("Google Document AI OCR failed.");
  const data = await response.json();
  const text = enhanceDocumentAiText(data.document);
  return { provider: "Google Document AI", text };
}

async function documentAiAccessToken() {
  const clientEmail = process.env.GOOGLE_DOCUMENT_AI_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_DOCUMENT_AI_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Google Document AI service account is not configured.");

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    },
    privateKey
  );

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("Google Document AI authentication failed.");
  const data = await response.json();
  if (!data.access_token) throw new Error("Google Document AI authentication failed.");
  return data.access_token;
}

function signJwt(header, payload, privateKey) {
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = require("crypto").createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function enhanceDocumentAiText(document) {
  const baseText = document?.text || "";
  const entityLines = (document?.entities || [])
    .map((entity) => {
      const label = entity.type || "";
      const value = entity.mentionText || entity.normalizedValue?.text || "";
      return label && value ? `${label}: ${value}` : "";
    })
    .filter(Boolean);
  return [baseText, ...entityLines].filter(Boolean).join("\n").trim();
}

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
