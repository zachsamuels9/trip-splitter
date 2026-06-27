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

  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "OCR_SPACE_API_KEY is not configured." });
    return;
  }

  try {
    const body = await readRawBody(req);
    const contentType = req.headers["content-type"];
    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        apikey: apiKey,
        "content-type": contentType,
      },
      body,
    });
    if (!response.ok) {
      res.status(response.status).json({ error: "OCR provider request failed." });
      return;
    }
    const data = await response.json();
    if (data.IsErroredOnProcessing) {
      res.status(422).json({ error: data.ErrorMessage || "OCR processing failed." });
      return;
    }
    const text = data.ParsedResults?.map((result) => result.ParsedText).filter(Boolean).join("\n").trim();
    res.status(200).json({ text });
  } catch (error) {
    res.status(500).json({ error: error.message || "OCR failed." });
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 10_000_000) {
        reject(new Error("Upload is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
