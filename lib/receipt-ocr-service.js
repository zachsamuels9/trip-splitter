const crypto = require("crypto");

const cache = new Map();
const CACHE_LIMIT = 50;

async function processReceiptImage({ imageDataUrl }) {
  const imageBase64 = extractImageBase64(imageDataUrl);
  const mimeType = imageDataUrl.match(/^data:([^;]+)/i)?.[1] || "image/jpeg";
  if (!imageBase64) {
    const error = new Error("Receipt image is required.");
    error.statusCode = 400;
    throw error;
  }

  const cacheKey = crypto.createHash("sha256").update(imageBase64).digest("hex");
  if (cache.has(cacheKey)) {
    log("cache hit", { cacheKey: cacheKey.slice(0, 12) });
    return { ...cache.get(cacheKey), cached: true };
  }

  const document = await callDocumentAi(imageBase64, mimeType);
  const receipt = await extractStructuredReceipt(document);
  const result = {
    provider: "Google Document AI Expense Parser",
    text: document.text || "",
    receipt,
    rawEntityCount: document.entities?.length || 0,
    cached: false,
  };
  writeCache(cacheKey, result);
  return result;
}

function extractImageBase64(imageDataUrl) {
  return String(imageDataUrl || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}

async function callDocumentAi(imageBase64, mimeType) {
  const projectId = requiredEnv("GOOGLE_DOCUMENT_AI_PROJECT_ID");
  const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION || "us";
  const processorId = requiredEnv("GOOGLE_DOCUMENT_AI_PROCESSOR_ID");
  const accessToken = await documentAiAccessToken();
  const endpoint = `https://${location}-documentai.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/processors/${encodeURIComponent(processorId)}:process`;
  log("request", { location, processorId: processorId.slice(0, 8), mimeType, bytes: Math.round((imageBase64.length * 3) / 4) });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: {
        content: imageBase64,
        mimeType,
      },
      processOptions: {
        ocrConfig: {
          enableImageQualityScores: true,
          enableSymbol: false,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log("parser failure", { status: response.status, detail: detail.slice(0, 500) });
    const error = new Error(`Google Document AI parser failed (${response.status}). ${detail || "Check processor permissions and location."}`);
    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();
  const document = data.document || {};
  log("parsed", { entities: document.entities?.length || 0, pages: document.pages?.length || 0 });
  return document;
}

async function documentAiAccessToken() {
  const clientEmail = requiredEnv("GOOGLE_DOCUMENT_AI_CLIENT_EMAIL");
  const privateKey = normalizePrivateKey(requiredEnv("GOOGLE_DOCUMENT_AI_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    },
    privateKey
  );

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log("auth failure", { status: response.status, detail: detail.slice(0, 500) });
    const error = new Error(`Google Document AI authentication failed (${response.status}). Check service account email/private key.`);
    error.statusCode = response.status;
    throw error;
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("Google Document AI authentication did not return an access token.");
  return data.access_token;
}

function normalizePrivateKey(value) {
  return String(value || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/^'|'$/g, "")
    .replace(/\\n/g, "\n");
}

function signJwt(header, payload, privateKey) {
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function extractStructuredReceipt(document) {
  const entities = document.entities || [];
  const receipt = {
    merchant: entityString(entities, ["supplier_name", "merchant_name", "restaurant_name", "vendor_name"]),
    date: entityDate(entities, ["receipt_date", "purchase_date", "invoice_date", "date"]),
    currency: entityCurrency(entities) || "USD",
    subtotal: entityMoney(entities, ["net_amount", "subtotal", "sub_total"]),
    tax: entityMoney(entities, ["total_tax_amount", "tax", "tax_amount"]),
    tip: entityMoney(entities, ["tip", "gratuity", "tip_amount"]),
    fees: entityMoney(entities, ["fee", "fees", "service_charge", "surcharge"]),
    total: entityMoney(entities, ["total_amount", "amount_due", "grand_total"]),
    discount: entityMoney(entities, ["discount", "discount_amount"]) || 0,
    lineItems: extractLineItems(entities),
    warnings: [],
  };
  receipt.lineItems = await normalizeLineItemsWithGpt(receipt.lineItems);
  if (!receipt.lineItems.length) receipt.warnings.push("No individual line items were returned by Document AI.");
  if (!receipt.total) receipt.warnings.push("No receipt total was returned by Document AI.");
  return receipt;
}

function extractLineItems(entities) {
  const rows = entities.filter((entity) => normalizeType(entity.type) === "line_item");
  const nestedRows = rows.map((row) => lineItemFromProperties(row)).filter((item) => item.name || item.amount);
  if (nestedRows.length) return nestedRows;

  const grouped = new Map();
  entities
    .filter((entity) => normalizeType(entity.type).startsWith("line_item/"))
    .forEach((entity, index) => {
      const key = entity.id || entity.mentionId || String(index);
      const field = normalizeType(entity.type).split("/").pop();
      const row = grouped.get(key) || {};
      assignLineItemField(row, field, entity);
      grouped.set(key, row);
    });
  return Array.from(grouped.values()).filter((item) => item.name || item.amount).map(finalizeLineItem);
}

function lineItemFromProperties(row) {
  const item = {};
  (row.properties || []).forEach((property) => {
    const field = normalizeType(property.type).split("/").pop();
    assignLineItemField(item, field, property);
  });
  if (!item.name && row.mentionText) item.name = cleanText(row.mentionText);
  return finalizeLineItem(item);
}

function assignLineItemField(item, field, entity) {
  if (["description", "name", "item_name", "product_name"].includes(field)) item.name = cleanText(entity.mentionText || entity.normalizedValue?.text);
  else if (["quantity", "qty"].includes(field)) item.quantity = numberFromEntity(entity) || item.quantity;
  else if (["unit_price", "price"].includes(field)) item.unitPrice = moneyFromEntity(entity) || item.unitPrice;
  else if (["amount", "total_amount", "line_total"].includes(field)) item.amount = moneyFromEntity(entity) || item.amount;
  else if (["currency"].includes(field)) item.currency = entity.normalizedValue?.text || entity.mentionText || item.currency;
}

function finalizeLineItem(item) {
  const quantity = Math.max(1, Math.round(Number(item.quantity || 1)));
  const unitPrice = roundCents(Number(item.unitPrice || (item.amount && quantity ? item.amount / quantity : 0)));
  const amount = roundCents(Number(item.amount || unitPrice * quantity));
  return {
    name: cleanText(item.name || "Item"),
    quantity,
    unitPrice,
    amount,
    category: item.category || "",
    normalizedName: item.normalizedName || "",
  };
}

async function normalizeLineItemsWithGpt(lineItems) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !lineItems.length) return lineItems;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "Normalize receipt line item names only. Expand abbreviations, translate to English when necessary, assign a broad category, and keep quantities and prices unchanged. Return strict JSON array with name, normalizedName, category, quantity, unitPrice, amount.",
          },
          { role: "user", content: JSON.stringify(lineItems) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`GPT normalization failed (${response.status}).`);
    const data = await response.json();
    const text = data.output_text || data.output?.flatMap((item) => item.content || []).map((item) => item.text).filter(Boolean).join("\n") || "";
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return lineItems;
    return parsed.map((item, index) => finalizeLineItem({ ...lineItems[index], ...item }));
  } catch (error) {
    log("gpt normalization skipped", { error: error.message });
    return lineItems;
  }
}

function entityString(entities, names) {
  const entity = firstEntity(entities, names);
  return cleanText(entity?.normalizedValue?.text || entity?.mentionText || "");
}

function entityDate(entities, names) {
  const entity = firstEntity(entities, names);
  const date = entity?.normalizedValue?.dateValue;
  if (date?.year && date?.month && date?.day) {
    return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  }
  return normalizeDate(entity?.normalizedValue?.text || entity?.mentionText || "");
}

function entityMoney(entities, names) {
  const entity = firstEntity(entities, names);
  return moneyFromEntity(entity);
}

function entityCurrency(entities) {
  const explicit = firstEntity(entities, ["currency", "currency_code"]);
  const value = explicit?.normalizedValue?.text || explicit?.mentionText;
  const moneyCurrency = entities.map((entity) => entity.normalizedValue?.moneyValue?.currencyCode).find(Boolean);
  return normalizeCurrency(value || moneyCurrency || "");
}

function firstEntity(entities, names) {
  const normalizedNames = names.map(normalizeType);
  return entities.find((entity) => normalizedNames.includes(normalizeType(entity.type)));
}

function moneyFromEntity(entity) {
  if (!entity) return 0;
  const money = entity.normalizedValue?.moneyValue;
  if (money) return roundCents(Number(money.units || 0) + Number(money.nanos || 0) / 1_000_000_000);
  return parseAmount(entity.normalizedValue?.text || entity.mentionText || "");
}

function numberFromEntity(entity) {
  const value = entity?.normalizedValue?.text || entity?.mentionText || "";
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseAmount(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? roundCents(Number(match[0])) : 0;
}

function normalizeDate(value) {
  const text = String(value || "");
  const iso = text.match(/\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = text.match(/\b(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])[-/.]((?:20)?\d{2})\b/);
  if (!us) return "";
  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
}

function normalizeCurrency(value) {
  const text = String(value || "").toUpperCase();
  if (/THB|BAHT|฿/.test(text)) return "THB";
  if (/VND|DONG|VNĐ|₫/.test(text)) return "VND";
  if (/USD|\$/.test(text)) return "USD";
  return "";
}

function normalizeType(type) {
  return String(type || "").toLowerCase().replace(/\s+/g, "_");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function roundCents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`${name} is not configured.`);
    error.statusCode = 503;
    throw error;
  }
  return value;
}

function writeCache(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function log(message, meta = {}) {
  console.info(`[receiptOCRService] ${message}`, meta);
}

module.exports = {
  processReceiptImage,
};
