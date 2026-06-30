const { addPerson, closeGroup, createGroup, getRequiredGroup, publicGroup, reopenGroup, removePerson, resetTrip, upsertReceipt } = require("../../lib/group-store");

module.exports = async function handler(req, res) {
  try {
    const parts = Array.isArray(req.query.path) ? req.query.path : [];
    const [groupId, child, personId] = parts;
    if (!groupId) {
      if (req.method === "POST") {
        const result = await createGroup(parseBody(req.body));
        res.status(201).json(result);
        return;
      }
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (req.method === "GET" && !child) {
      const group = await getRequiredGroup(groupId);
      res.status(200).json(publicGroup(group));
      return;
    }

    if (req.method === "POST" && child === "people") {
      const result = await addPerson(groupId, req.body?.name, req.body || {});
      res.status(201).json(result);
      return;
    }

    if (req.method === "DELETE" && child === "people" && personId) {
      const result = await removePerson(groupId, personId);
      res.status(200).json(result);
      return;
    }

    if (req.method === "POST" && child === "receipts") {
      const result = await upsertReceipt(groupId, req.body?.receipt);
      res.status(200).json(result);
      return;
    }

    if (req.method === "POST" && child === "close") {
      const result = await closeGroup(groupId);
      res.status(200).json(result);
      return;
    }

    if (req.method === "POST" && child === "reopen") {
      const result = await reopenGroup(groupId);
      res.status(200).json(result);
      return;
    }

    if (req.method === "POST" && child === "reset") {
      const result = await resetTrip(groupId);
      res.status(200).json(result);
      return;
    }

    res.status(404).json({ error: "Not found" });
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
