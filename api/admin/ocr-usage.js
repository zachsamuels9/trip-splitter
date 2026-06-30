const { getOcrUsage, setActiveMonthlyLimit } = require("../../lib/ocr-usage-store");

module.exports = async function handler(req, res) {
  try {
    if (!["GET", "PATCH"].includes(req.method)) {
      res.setHeader("Allow", "GET, PATCH");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    if (req.query.password !== "1234") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method === "PATCH") {
      res.status(200).json({ usage: await setActiveMonthlyLimit(parseBody(req.body).limit) });
      return;
    }
    res.status(200).json({ usage: await getOcrUsage() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
  }
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}
