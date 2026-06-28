const { signInAccount } = require("../lib/group-store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const result = await signInAccount(parseBody(req.body));
    if (!result.account) {
      res.status(401).json({ error: "No account matched that email and passcode." });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Account sign-in failed." });
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
