const memoryUsage = new Map();
const memorySettings = new Map();
const limitSettingKey = "monthly_limit";

function defaultMonthlyLimit() {
  const value = Number(process.env.MAX_MONTHLY_OCR_REQUESTS || 100);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
}

function usageMonth(date = new Date(), timeZone = "") {
  const normalizedTimeZone = safeTimeZone(timeZone);
  if (!normalizedTimeZone) return date.toISOString().slice(0, 7);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : date.toISOString().slice(0, 7);
}

function safeTimeZone(timeZone) {
  const value = String(timeZone || "").trim();
  if (!value) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "";
  }
}

function supabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

async function getOcrUsage(month = usageMonth()) {
  try {
    const usage = await readUsage(month);
    const limit = await getActiveMonthlyLimit();
    return summarizeUsage(usage, limit);
  } catch (error) {
    if (isMissingOcrSchema(error)) throw ocrSetupError();
    throw error;
  }
}

async function assertOcrUsageAvailable(month = usageMonth()) {
  let usage;
  let limit;
  try {
    usage = await readUsage(month);
    limit = await getActiveMonthlyLimit();
  } catch (error) {
    logUsage("usage check failed", { month, error: error.message });
    if (isMissingOcrSchema(error)) throw ocrSetupError();
    throw usageUnavailableError();
  }
  if (Number(usage.total_requests_attempted || 0) >= limit) {
    const error = new Error("OCR is temporarily unavailable because this month's scan limit has been reached. You can still manually enter the expense.");
    error.statusCode = 429;
    error.code = "OCR_MONTHLY_LIMIT_REACHED";
    logUsage("monthly limit reached", { month, limit, attempted: usage.total_requests_attempted || 0 });
    throw error;
  }
  return summarizeUsage(usage, limit);
}

function usageUnavailableError() {
  const error = new Error("OCR is temporarily unavailable because usage tracking could not be verified. You can still manually enter the expense.");
  error.statusCode = 503;
  error.code = "OCR_USAGE_UNAVAILABLE";
  return error;
}

function ocrSetupError() {
  const error = new Error("OCR usage tracking is not set up yet. Run supabase-ocr-usage.sql in Supabase, then refresh the admin panel.");
  error.statusCode = 503;
  error.code = "OCR_USAGE_SETUP_REQUIRED";
  return error;
}

function isMissingOcrSchema(error) {
  return /ocr_usage_(months|settings)|PGRST205|schema cache|Could not find the table/i.test(error?.message || "");
}

async function recordOcrAttemptStarted(month = usageMonth()) {
  const now = new Date().toISOString();
  const usage = await readUsage(month);
  const next = {
    month,
    total_requests_attempted: Number(usage.total_requests_attempted || 0) + 1,
    total_requests_successful: Number(usage.total_requests_successful || 0),
    total_requests_failed: Number(usage.total_requests_failed || 0),
    last_request_at: now,
    updated_at: now,
  };
  await writeUsage(next);
  logUsage("attempt recorded", { month, attempted: next.total_requests_attempted, lastRequestAt: now });
  return summarizeUsage(next, await getActiveMonthlyLimit());
}

async function recordOcrAttemptResult(success, month = usageMonth()) {
  const now = new Date().toISOString();
  const usage = await readUsage(month);
  const next = {
    month,
    total_requests_attempted: Number(usage.total_requests_attempted || 0),
    total_requests_successful: Number(usage.total_requests_successful || 0) + (success ? 1 : 0),
    total_requests_failed: Number(usage.total_requests_failed || 0) + (success ? 0 : 1),
    last_request_at: now,
    updated_at: now,
  };
  await writeUsage(next);
  logUsage(success ? "success recorded" : "failure recorded", {
    month,
    successful: next.total_requests_successful,
    failed: next.total_requests_failed,
    lastRequestAt: now,
  });
  return summarizeUsage(next, await getActiveMonthlyLimit());
}

async function getActiveMonthlyLimit() {
  const configured = await readSetting(limitSettingKey);
  const value = Number(configured?.value);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultMonthlyLimit();
}

async function setActiveMonthlyLimit(limit, month = usageMonth()) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 1) {
    const error = new Error("OCR monthly limit must be at least 1.");
    error.statusCode = 400;
    throw error;
  }
  const normalized = Math.floor(value);
  try {
    await writeSetting({
      key: limitSettingKey,
      value: String(normalized),
      updated_at: new Date().toISOString(),
    });
    logUsage("monthly limit updated", { limit: normalized });
    return getOcrUsage(month);
  } catch (error) {
    if (isMissingOcrSchema(error)) throw ocrSetupError();
    throw error;
  }
}

async function readUsage(month) {
  const env = supabaseEnv();
  if (!env) return readMemoryUsage(month);
  const rows = await supabase(`ocr_usage_months?month=eq.${encodeURIComponent(month)}&limit=1`);
  return rows?.[0] || emptyUsage(month);
}

async function writeUsage(usage) {
  const env = supabaseEnv();
  if (!env) {
    memoryUsage.set(usage.month, usage);
    return usage;
  }
  try {
    const rows = await supabase("ocr_usage_months?on_conflict=month", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: usage,
    });
    return rows?.[0] || usage;
  } catch (error) {
    logUsage("persistent write failed", { month: usage.month, error: error.message });
    throw error;
  }
}

async function readSetting(key) {
  const env = supabaseEnv();
  if (!env) return memorySettings.get(key) || null;
  const rows = await supabase(`ocr_usage_settings?key=eq.${encodeURIComponent(key)}&limit=1`);
  return rows?.[0] || null;
}

async function writeSetting(setting) {
  const env = supabaseEnv();
  if (!env) {
    memorySettings.set(setting.key, setting);
    return setting;
  }
  try {
    const rows = await supabase("ocr_usage_settings?on_conflict=key", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: setting,
    });
    return rows?.[0] || setting;
  } catch (error) {
    logUsage("settings write failed", { key: setting.key, error: error.message });
    throw error;
  }
}

async function supabase(path, options = {}) {
  const env = supabaseEnv();
  if (!env) {
    const error = new Error("Supabase is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${env.url}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`Supabase request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
    error.statusCode = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function readMemoryUsage(month) {
  return memoryUsage.get(month) || emptyUsage(month);
}

function emptyUsage(month) {
  return {
    month,
    total_requests_attempted: 0,
    total_requests_successful: 0,
    total_requests_failed: 0,
    last_request_at: null,
  };
}

function summarizeUsage(usage, activeLimit = defaultMonthlyLimit()) {
  const attempted = Number(usage.total_requests_attempted || 0);
  const limit = Number(activeLimit || defaultMonthlyLimit());
  return {
    month: usage.month || usageMonth(),
    limit,
    attempted,
    successful: Number(usage.total_requests_successful || 0),
    failed: Number(usage.total_requests_failed || 0),
    used: attempted,
    remaining: Math.max(0, limit - attempted),
    estimatedCostLow: Math.round(attempted * 0.1 * 100) / 100,
    estimatedCostHigh: Math.round(attempted * 0.2 * 100) / 100,
    lastRequestAt: usage.last_request_at || null,
  };
}

function logUsage(message, meta = {}) {
  console.info("[ocrUsage]", message, meta);
}

module.exports = {
  assertOcrUsageAvailable,
  defaultMonthlyLimit,
  getActiveMonthlyLimit,
  getOcrUsage,
  recordOcrAttemptResult,
  recordOcrAttemptStarted,
  setActiveMonthlyLimit,
  usageMonth,
};
