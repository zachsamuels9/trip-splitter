const crypto = require("crypto");

const keyPrefix = "trip-split:group:";

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    people: group.people,
    receipts: group.receipts,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function createPerson(name) {
  return {
    id: crypto.randomUUID(),
    name: String(name || "Guest").trim().slice(0, 60) || "Guest",
    createdAt: new Date().toISOString(),
  };
}

function requireRedisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const error = new Error("Shared groups require UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
    error.statusCode = 503;
    throw error;
  }
  return { url: url.replace(/\/$/, ""), token };
}

async function redis(command) {
  const { url, token } = requireRedisEnv();
  const response = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command]),
  });
  if (!response.ok) throw new Error(`Redis request failed: ${response.status}`);
  const [result] = await response.json();
  if (result.error) throw new Error(result.error);
  return result.result;
}

async function getGroup(id) {
  const value = await redis(["GET", `${keyPrefix}${id}`]);
  return value ? JSON.parse(value) : null;
}

async function saveGroup(group) {
  group.updatedAt = new Date().toISOString();
  await redis(["SET", `${keyPrefix}${group.id}`, JSON.stringify(group)]);
  return group;
}

async function createGroup({ name, personName }) {
  const person = createPerson(personName || "You");
  const group = {
    id: crypto.randomBytes(5).toString("hex"),
    name: String(name || "Trip group").trim().slice(0, 80) || "Trip group",
    people: [person],
    receipts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveGroup(group);
  return { group: publicGroup(group), person };
}

async function addPerson(groupId, name) {
  const group = await getRequiredGroup(groupId);
  const person = createPerson(name);
  group.people.push(person);
  await saveGroup(group);
  return { group: publicGroup(group), person };
}

async function upsertReceipt(groupId, receipt) {
  if (!receipt?.id) {
    const error = new Error("Receipt is required.");
    error.statusCode = 400;
    throw error;
  }
  const group = await getRequiredGroup(groupId);
  const index = group.receipts.findIndex((item) => item.id === receipt.id);
  if (index >= 0) group.receipts[index] = receipt;
  else group.receipts.unshift(receipt);
  await saveGroup(group);
  return { group: publicGroup(group), receipt };
}

async function getRequiredGroup(groupId) {
  const group = await getGroup(groupId);
  if (!group) {
    const error = new Error("Group not found.");
    error.statusCode = 404;
    throw error;
  }
  return group;
}

module.exports = {
  addPerson,
  createGroup,
  getRequiredGroup,
  publicGroup,
  upsertReceipt,
};
