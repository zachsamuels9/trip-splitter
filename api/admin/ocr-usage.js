const { getOcrUsage, setActiveMonthlyLimit, usageMonth } = require("../../lib/ocr-usage-store");

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
      const body = parseBody(req.body);
      res.status(200).json({ usage: await setActiveMonthlyLimit(body.limit, localUsageMonth(req.query.timeZone || body.timeZone || "")) });
      return;
    }
    res.status(200).json({ usage: await getOcrUsage(localUsageMonth(req.query.timeZone || "")) });
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

function localUsageMonth(timeZone) {
  return usageMonth(new Date(), timeZone);
}
