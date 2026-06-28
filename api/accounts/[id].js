const { updateAccount } = require("../../lib/group-store");

module.exports = async function handler(req, res) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const result = await updateAccount(req.query.id, parseBody(req.body));
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Account update failed." });
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
