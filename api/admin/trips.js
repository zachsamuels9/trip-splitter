const { listTrips } = require("../../lib/group-store");

module.exports = async function handler(req, res) {
  try {
    if (req.query.password !== "1234") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    res.status(200).json(await listTrips());
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
  }
};
