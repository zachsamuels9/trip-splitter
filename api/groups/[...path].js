const { addPerson, closeGroup, createGroup, getRequiredGroup, publicGroup, reopenGroup, resetTrip, upsertReceipt } = require("../../lib/group-store");
const { getOcrUsage, setActiveMonthlyLimit } = require("../../lib/ocr-usage-store");

module.exports = async function handler(req, res) {
  try {
    const parts = Array.isArray(req.query.path) ? req.query.path : [];
    const [groupId, child] = parts;
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

    if (["GET", "PATCH"].includes(req.method) && child === "ocr-usage") {
      const group = publicGroup(await getRequiredGroup(groupId));
      const participantId = req.query.participantId || "";
      const accountId = req.query.accountId || "";
      if (!canViewOcrUsage(group, participantId, accountId)) {
        res.status(403).json({ error: "Only the trip owner can view OCR usage." });
        return;
      }
      if (req.method === "PATCH") {
        res.status(200).json({ usage: await setActiveMonthlyLimit(parseBody(req.body).limit) });
        return;
      }
      res.status(200).json({ usage: await getOcrUsage() });
      return;
    }

    if (req.method === "POST" && child === "people") {
      const result = await addPerson(groupId, req.body?.name, req.body || {});
      res.status(201).json(result);
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

function canViewOcrUsage(group, participantId, accountId) {
  if (group.ownerParticipantId && participantId && group.ownerParticipantId === participantId) return true;
  if (group.ownerAccountId && accountId && group.ownerAccountId === accountId) return true;
  if (!group.ownerParticipantId && !group.ownerAccountId && group.people?.[0]?.id === participantId) return true;
  return false;
}

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
