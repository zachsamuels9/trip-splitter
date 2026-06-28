const { deleteTrip } = require("../../../lib/group-store");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "DELETE") {
      res.setHeader("Allow", "DELETE");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = parseBody(req.body);
    if (body.password !== "1234") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.status(200).json(await deleteTrip(req.query.id));
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
