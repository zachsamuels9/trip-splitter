const { addPerson, getRequiredGroup, publicGroup, upsertReceipt } = require("../../lib/group-store");

module.exports = async function handler(req, res) {
  try {
    const parts = Array.isArray(req.query.path) ? req.query.path : [];
    const [groupId, child] = parts;
    if (!groupId) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (req.method === "GET" && !child) {
      const group = await getRequiredGroup(groupId);
      res.status(200).json(publicGroup(group));
      return;
    }

    if (req.method === "POST" && child === "people") {
      const result = await addPerson(groupId, req.body?.name);
      res.status(201).json(result);
      return;
    }

    if (req.method === "POST" && child === "receipts") {
      const result = await upsertReceipt(groupId, req.body?.receipt);
      res.status(200).json(result);
      return;
    }

    res.status(404).json({ error: "Not found" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
  }
};
