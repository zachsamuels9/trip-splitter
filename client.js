const storeKey = "trip-split-state-v2";
const rateKey = "trip-split-rates-v1";
const groupsKey = "trip-split-known-groups-v1";
const supportedCurrencies = ["USD", "THB", "VND"];
const defaultRates = { USD: 1, THB: 36.7, VND: 25400 };
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const browserDocument = isBrowser ? document : null;

let state = loadState();
let rates = loadRates();
let parsedReceipt = null;
let splitMode = "items";
let splitCount = 2;
let splitEvenPeople = [];
let editingReceiptId = null;
let activeGroupId = currentGroupId();
let activePersonId = activeGroupId ? readStorage(`trip-split-person-${activeGroupId}`) || "" : "";
let activeGroup = null;
let syncTimer = null;
let deferredInstallPrompt = null;
let installReturnScreen = "home";
const settingsReturnScreens = new Set();

const $ = (selector) => browserDocument?.querySelector(selector) || null;
const $$ = (selector) => Array.from(browserDocument?.querySelectorAll(selector) || []);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

if (isBrowser) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  browserDocument.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    seedManualRows();
    registerServiceWorker();
    refreshRates();
    await initGroup();
    render();
    if (isStartRoute() && !activeGroupId) {
      showStartOnboarding();
    } else if (!activeGroupId || activePersonId) {
      showScreen(activeGroupId ? "home" : "groups");
    }
  });
}

function loadState() {
  const saved = readStorage(storeKey);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      return defaultState();
    }
  }
  return defaultState();
}

function defaultState() {
  return {
    people: [
      { id: createId(), name: "You" },
      { id: createId(), name: "Friend" },
    ],
    receipts: [],
  };
}

function loadRates() {
  const saved = readStorage(rateKey);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      return { base: "USD", updatedAt: null, rates: defaultRates };
    }
  }
  return { base: "USD", updatedAt: null, rates: defaultRates };
}

function saveState() {
  writeStorage(storeKey, JSON.stringify(state));
}

function saveRates() {
  writeStorage(rateKey, JSON.stringify(rates));
}

function loadKnownGroups() {
  const saved = readStorage(groupsKey);
  if (!saved) return [];
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
}

function saveKnownGroups(groups) {
  writeStorage(groupsKey, JSON.stringify(groups));
}

function rememberGroup(group, personId) {
  if (!group?.id) return;
  const groups = loadKnownGroups().filter((entry) => entry.id !== group.id);
  groups.unshift({
    id: group.id,
    name: group.name || "Trip group",
    personId: personId || readStorage(`trip-split-person-${group.id}`) || "",
    updatedAt: new Date().toISOString(),
  });
  saveKnownGroups(groups.slice(0, 12));
}

function currentGroupId() {
  const savedGroupId = readStorage("trip-split-group-id") || "";
  if (!isBrowser) return savedGroupId;
  try {
    const params = new URLSearchParams(window.location.search);
    const invitedGroupId = params.get("group") || "";
    if (invitedGroupId) return invitedGroupId;
    return isStartRoute() ? "" : savedGroupId;
  } catch {
    return savedGroupId;
  }
}

function isStartRoute() {
  if (!isBrowser) return false;
  return window.location.pathname.replace(/\/$/, "") === "/start";
}

function readStorage(key) {
  if (!isBrowser) return null;
  try {
    return window.localStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  if (!isBrowser) return;
  try {
    window.localStorage?.setItem(key, value);
  } catch {}
}

function removeStorage(key) {
  if (!isBrowser) return;
  try {
    window.localStorage?.removeItem(key);
  } catch {}
}

function safeAlert(message) {
  if (isBrowser && typeof window.alert === "function") window.alert(message);
}

function safeConfirm(message) {
  if (!isBrowser || typeof window.confirm !== "function") return false;
  return window.confirm(message);
}

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function bindEvents() {
  $$("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      const active = $(".screen.active")?.id;
      const target = button.dataset.screen;
      if (active === "screen-settings" && ["people", "totals"].includes(target)) settingsReturnScreens.add(target);
      showScreen(target);
    });
  });

  $("#resetApp").addEventListener("click", () => {
    if (!safeConfirm("Reset people, receipts, and balances?")) return;
    removeStorage(storeKey);
    if (activeGroupId) {
      removeStorage("trip-split-group-id");
      removeStorage(`trip-split-person-${activeGroupId}`);
    }
    state = loadState();
    parsedReceipt = null;
    activeGroupId = "";
    activePersonId = "";
    activeGroup = null;
    splitMode = "items";
    render();
    showScreen("home");
  });
  $("#newGroup").addEventListener("click", () => {
    activeGroupId = "";
    activePersonId = "";
    activeGroup = null;
    state = defaultState();
    render();
    if (isBrowser) window.history.pushState(null, "", "/start");
    showStartOnboarding();
  });
  $("#installNative").addEventListener("click", promptInstall);
  $("#installBack").addEventListener("click", () => showScreen(installReturnScreen));
  $("#installCopyInvite").addEventListener("click", copyInviteLink);
  $("#showInstallHelp").addEventListener("click", () => {
    installReturnScreen = "settings";
    showScreen("install");
  });
  $("#settingsInvite").addEventListener("click", () => showScreen("invite"));
  $("#settingsCopyInvite").addEventListener("click", copyInviteLink);
  $("#downloadAllReceipts").addEventListener("click", downloadAllReceipts);
  $("#leaveTrip").addEventListener("click", leaveTrip);
  $("#loggedInBox").addEventListener("click", leaveTrip);
  $("#openReceipts").addEventListener("click", () => showScreen("totals"));
  $("#receiptSort").addEventListener("change", renderHistory);
  $("#closeTrip").addEventListener("click", closeTrip);
  $("#itemizeReceiptPreview").addEventListener("click", openReceiptImagePreview);
  $("#closeImageViewer").addEventListener("click", closeReceiptImagePreview);
  $("#imageViewerDownload").addEventListener("click", downloadPreviewImage);

  $("#openManual").addEventListener("click", () => {
    setTodayIfBlank();
    showScreen("manual");
  });
  $("#openScan").addEventListener("click", () => {
    resetScanStatus();
    showScreen("scan");
  });

  $("#personForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  $("#createGroup").addEventListener("click", createGroup);
  $("#copyInvite").addEventListener("click", copyInviteLink);
  $("#joinGroupForm").addEventListener("submit", joinGroup);

  $("#receiptImage").addEventListener("change", scanImage);
  $("#receiptUpload").addEventListener("change", scanImage);
  $("#addManualItem").addEventListener("click", () => addManualItem());
  $("#manualToItemize").addEventListener("click", buildManualReceipt);
  $("#addParsedItem").addEventListener("click", addParsedItem);
  $("#reviewSelections").addEventListener("click", reviewSelections);
  $("#acceptSelections").addEventListener("click", () => saveReceipt(false, true));
  $("#saveLaterReceipt").addEventListener("click", () => saveReceipt(true));
  $("#confirmationHome").addEventListener("click", () => showScreen("home"));
  $("#confirmationAddAnother").addEventListener("click", () => {
    resetScanStatus();
    showScreen("scan");
  });
  $("#decreaseSplit").addEventListener("click", () => updateSplitCount(splitCount - 1));
  $("#increaseSplit").addEventListener("click", () => updateSplitCount(splitCount + 1));

  ["manualTip", "manualTax", "manualFees", "manualDiscount"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderManualReview);
  });

  ["reviewName", "reviewDate", "reviewNotes"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateParsedDetails);
  });
  $("#reviewCurrency").addEventListener("change", updateParsedCurrency);
  $("#reviewPaidBy").addEventListener("change", () => {});

  ["reviewTip", "reviewTax", "reviewFees", "reviewDiscount"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateParsedAdjustments);
  });

  $$(".method").forEach((button) => {
    button.addEventListener("click", () => setSplitMode(button.dataset.splitMode));
  });
}

function showScreen(name) {
  browserDocument?.body.classList.remove("start-onboarding");
  updateBackTargets(name);
  $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === `screen-${name}`));
  if (name === "install") renderInstallScreen();
  if (name === "invite") renderInviteScreen();
  if (isBrowser) window.scrollTo({ top: 0, behavior: "instant" });
  makeIcons();
}

function renderInviteScreen() {
  $("#settingsInviteLink").value = activeGroupId ? inviteUrl() : `${location.origin}/start`;
}

function updateBackTargets(name) {
  ["people", "totals"].forEach((screenName) => {
    const button = $(`#screen-${screenName} .back-button`);
    if (button) button.dataset.screen = settingsReturnScreens.has(screenName) ? "settings" : "home";
  });
  if (name === "home") settingsReturnScreens.clear();
}

function showStartOnboarding() {
  browserDocument?.body.classList.add("start-onboarding");
  showScreen("home");
  browserDocument?.body.classList.add("start-onboarding");
}

async function refreshRates() {
  updateRateStatus("Rates loading");
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
    if (!response.ok) throw new Error("Rate service unavailable");
    const data = await response.json();
    const nextRates = { ...defaultRates };
    supportedCurrencies.forEach((currency) => {
      if (data.rates[currency]) nextRates[currency] = data.rates[currency];
    });
    rates = {
      base: "USD",
      updatedAt: data.time_last_update_utc || new Date().toUTCString(),
      rates: nextRates,
    };
    saveRates();
    updateRateStatus("⇄ Rates online");
  } catch {
    updateRateStatus(rates.updatedAt ? "Using saved rates" : "Using starter rates");
  }
}

function updateRateStatus(text) {
  $("#rateStatus").textContent = text;
}

async function initGroup() {
  if (!activeGroupId) return;
  writeStorage("trip-split-group-id", activeGroupId);
  try {
    const group = await api(`/api/groups/${activeGroupId}`);
    activeGroup = group;
    $("#joinGroupName").textContent = group.name;
    if (!activePersonId || !group.people.some((person) => person.id === activePersonId)) {
      showScreen("join");
      renderGroupUi();
      return;
    }
    applyGroup(group);
    startSync();
  } catch {
    $("#groupStatus").textContent = "Group server offline";
  }
}

async function createGroup() {
  const name = $("#groupName").value.trim() || "Trip group";
  const personName = $("#ownerName").value.trim();
  if (!personName) {
    safeAlert("Enter your name to create the trip.");
    $("#ownerName").focus();
    return;
  }
  try {
    const result = await api("/api/groups", {
      method: "POST",
      body: { name, personName },
    });
    activeGroupId = result.group.id;
    activePersonId = result.person.id;
    writeStorage("trip-split-group-id", activeGroupId);
    writeStorage(`trip-split-person-${activeGroupId}`, activePersonId);
    writeStorage(`trip-split-owner-${activeGroupId}`, activePersonId);
    if (isBrowser) window.history.replaceState(null, "", inviteUrl());
    applyGroup(result.group);
    rememberGroup(result.group, activePersonId);
    startSync();
    render();
    installReturnScreen = "home";
    showScreen("install");
  } catch {
    safeAlert("Could not create a shared group. Start the Trip Split server and try again.");
  }
}

async function joinGroup(event) {
  event.preventDefault();
  const name = $("#joinName").value.trim();
  if (!name || !activeGroupId) return;
  try {
    const result = await api(`/api/groups/${activeGroupId}/people`, {
      method: "POST",
      body: { name },
    });
    activePersonId = result.person.id;
    writeStorage("trip-split-group-id", activeGroupId);
    writeStorage(`trip-split-person-${activeGroupId}`, activePersonId);
    applyGroup(result.group);
    rememberGroup(result.group, activePersonId);
    startSync();
    render();
    installReturnScreen = "home";
    showScreen("install");
  } catch {
    safeAlert("Could not join this trip. Check that the invite server is running.");
  }
}

async function copyInviteLink() {
  if (!activeGroupId) return;
  const link = inviteUrl();
  const activeScreen = $(".screen.active")?.id;
  const visibleInput = activeScreen === "screen-invite" ? $("#settingsInviteLink") : activeScreen === "screen-install" ? $("#installInviteLink") : $("#inviteLink");
  if (visibleInput) {
    visibleInput.value = link;
    visibleInput.select();
  }
  try {
    if (!isBrowser || !navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(link);
    const status = $("#groupStatus");
    if (status) status.textContent = "Invite copied";
  } catch {
    browserDocument?.execCommand("copy");
    const status = $("#groupStatus");
    if (status) status.textContent = "Invite copied";
  }
}

async function addPerson(name) {
  if (activeGroupId) {
    try {
      const result = await api(`/api/groups/${activeGroupId}/people`, {
        method: "POST",
        body: { name },
      });
      applyGroup(result.group);
      render();
      return;
    } catch {
      safeAlert("Could not add this person to the shared group.");
      return;
    }
  }
  state.people.push({ id: createId(), name });
  saveState();
  render();
}

async function saveGroupReceipt(receipt) {
  if (!activeGroupId || !activePersonId) return;
  try {
    const result = await api(`/api/groups/${activeGroupId}/receipts`, {
      method: "POST",
      body: { receipt },
    });
    applyGroup(result.group);
    render();
  } catch {
    $("#groupStatus").textContent = "Saved locally";
  }
}

function applyGroup(group) {
  activeGroup = group;
  state.people = group.people;
  state.receipts = group.receipts;
  saveState();
  rememberGroup(group, activePersonId);
}

function startSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncGroup, 4000);
}

async function syncGroup() {
  if (!activeGroupId || !activePersonId) return;
  try {
    const group = await api(`/api/groups/${activeGroupId}`);
    applyGroup(group);
    render();
  } catch {
    $("#groupStatus").textContent = "Sync paused";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function inviteUrl() {
  if (!isBrowser) return "";
  const url = new URL(window.location.href);
  url.pathname = "/start";
  url.searchParams.set("group", activeGroupId);
  return url.toString();
}

async function scanImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  prepareScanReceipt();
  showScreen("scan");
  updateScanProgress("Reading receipt", "Uploading photo for OCR...", true);

  try {
    const originalImageDataUrl = await fileToDataUrl(file);
    const imageDataUrl = await optimizeImageDataUrl(originalImageDataUrl);
    const ocr = await readReceiptText(imageDataUrl);
    const text = ocr.text;
    const detectedCurrency = detectCurrency(text, $("#receiptCurrency").value);
    $("#receiptCurrency").value = detectedCurrency;
    const restaurantName = detectRestaurantName(text);
    parsedReceipt = parseReceipt(text, detectedCurrency, {
      name: restaurantName || "Scanned receipt",
      restaurantName,
      date: detectReceiptDate(text) || new Date().toISOString().slice(0, 10),
      source: "scan",
      imageDataUrl,
    });
    parsedReceipt.ocrText = text;
    if (!parsedReceipt.items.length) {
      updateScanProgress("Needs review", "No priced items were found. Add them manually below.", false);
      showScreen("itemize");
      renderAssignment();
      return;
    }
    splitMode = "items";
    setSplitMode("items");
    updateScanProgress("Receipt read", `Ready to review in ${detectedCurrency} with ${ocr.provider}.`, false);
    showScreen("itemize");
    $("#scanStatus").textContent = "";
    renderAssignment();
  } catch (error) {
    updateScanProgress("Scan failed", error.message || "Could not read that photo. Try a brighter image or use manual entry.", false);
  } finally {
    event.target.value = "";
  }
}

async function readReceiptText(imageDataUrl) {
  updateScanProgress("Reading receipt", "Using server receipt OCR...", true);
  return readWithRemoteOcr(imageDataUrl);
}

function updateScanProgress(title, text, loading) {
  $("#scanModeLabel").textContent = loading ? "Scanning" : title;
  $("#scanProgress").classList.remove("hidden");
  $("#scanProgressTitle").textContent = title;
  $("#scanProgressText").textContent = text;
  const scanStatus = $("#scanStatus");
  if (scanStatus) scanStatus.textContent = text;
}

function resetScanStatus() {
  $("#scanModeLabel").textContent = "Ready";
  $("#scanProgress").classList.add("hidden");
  $("#scanProgressTitle").textContent = "Reading receipt";
  $("#scanProgressText").textContent = "Preparing image...";
}

async function readWithRemoteOcr(imageDataUrl) {
  const response = await fetch("/api/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || "Server OCR failed. Check OCR configuration.");
  }
  const data = await response.json();
  if (!data.text) throw new Error("No OCR text");
  return { provider: data.provider || "receipt OCR", text: data.text };
}

function optimizeImageDataUrl(imageDataUrl) {
  return new Promise((resolve) => {
    if (!isBrowser) {
      resolve(imageDataUrl);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = browserDocument.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    image.onerror = () => resolve(imageDataUrl);
    image.src = imageDataUrl;
  });
}

function prepareScanReceipt() {
  parsedReceipt = {
    currency: $("#receiptCurrency").value,
    name: "Scanned receipt",
    restaurantName: "",
    date: new Date().toISOString().slice(0, 10),
    items: [],
    fees: [],
    discount: 0,
    source: "scan",
    imageDataUrl: "",
  };
  renderAssignment();
}

function parseReceipt(text, currency, meta = {}) {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeReceiptLine(line))
    .filter(Boolean);

  const items = [];
  const fees = [];
  let discount = 0;

  lines.forEach((line) => {
    const amount = extractTrailingAmount(line, currency);
    if (!amount || amount.value === 0) return;
    const rawLabel = line.slice(0, amount.index).replace(/[^\w\s&'()./-]/g, " ").replace(/\s+/g, " ").trim();
    if (!isUsefulReceiptLabel(rawLabel)) return;

    const normalized = rawLabel.toLowerCase();
    const itemName = cleanItemName(rawLabel);
    const entry = { id: createId(), name: toTitle(itemName), amount: Math.abs(amount.value), assignedTo: [] };

    if (/(discount|promo|coupon|comp)/i.test(normalized)) {
      discount += Math.abs(amount.value);
      return;
    }

    const adjustment = adjustmentKind(normalized);
    if (adjustment) {
      if (adjustment === "discount") discount += Math.abs(amount.value);
      else fees.push({ id: entry.id, name: adjustmentLabel(adjustment), amount: Math.abs(amount.value) });
      return;
    }

    if (isLikelyFoodItem(itemName, amount.value, currency)) items.push(entry);
  });

  return {
    currency,
    name: meta.name || "Scanned receipt",
    restaurantName: meta.restaurantName || "",
    date: meta.date || new Date().toISOString().slice(0, 10),
    location: meta.location || "",
    description: meta.description || "",
    source: meta.source || "scan",
    imageDataUrl: meta.imageDataUrl || "",
    items,
    fees,
    discount,
  };
}

function adjustmentKind(text) {
  if (/(discount|promo|coupon|comp|reward|credit)/i.test(text)) return "discount";
  if (/(tip|gratuity)/i.test(text)) return "tip";
  if (/(tax|vat|gst|hst|sales tax)/i.test(text)) return "tax";
  if (/(service|fee|charge|surcharge|delivery|convenience)/i.test(text)) return "fees";
  return "";
}

function detectReceiptDate(text) {
  const sample = text || "";
  const iso = sample.match(/\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return normalizeDateParts(iso[1], iso[2], iso[3]);
  const us = sample.match(/\b(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])[-/.]((?:20)?\d{2})\b/);
  if (us) return normalizeDateParts(us[3], us[1], us[2]);
  return "";
}

function normalizeDateParts(year, month, day) {
  const fullYear = String(year).length === 2 ? `20${year}` : String(year);
  return `${fullYear.padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function detectCurrency(text, fallback = "USD") {
  const sample = text || "";
  if (/[฿]|(?:\bTHB\b|\bBAHT\b)/i.test(sample)) return "THB";
  if (/[₫]|(?:\bVND\b|\bDONG\b|\bVIETNAM\b|\bVNĐ\b)/i.test(sample)) return "VND";
  if (/\$|\bUSD\b/i.test(sample)) return "USD";
  return supportedCurrencies.includes(fallback) ? fallback : "USD";
}

function detectRestaurantName(text) {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeReceiptLine(line))
    .filter(Boolean)
    .slice(0, 12);
  const noise = /(welcome|customer copy|operator|phone|tel|drive thru|date|time|receipt|order|university|tempe|cashier|register|\d{3}[-\s]\d{3}[-\s]\d{4})/i;
  const chickFilA = lines.find((line) => /chick[\s-]?fil[\s-]?a/i.test(line));
  if (chickFilA) return "Chick-fil-A";
  const candidate = lines.find((line) => /[a-z]/i.test(line) && !noise.test(line) && line.length >= 3 && line.length <= 42);
  return candidate ? toTitle(candidate.replace(/^welcome to\s+/i, "")) : "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function normalizeReceiptLine(line) {
  return line
    .replace(/[|]/g, " ")
    .replace(/[¢©]/g, "0")
    .replace(/\bO(?=\d)/g, "0")
    .replace(/(\d)O\b/g, (_, digit) => `${digit}0`)
    .replace(/(\d)\s+([.,])\s+(\d)/g, "$1$2$3")
    .replace(/([$,฿₫])\s+(\d)/g, "$1$2")
    .replace(/(\d)\s+([.,])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTrailingAmount(line, currency) {
  const match = line.match(/(?:[$฿₫]?\s*)-?[\d][\d.,]*(?:\s*(?:USD|THB|VND|đ|d|baht|dong))?\s*$/i);
  if (!match) return null;
  const raw = match[0];
  const value = parseCurrencyNumber(raw, currency);
  if (!Number.isFinite(value)) return null;
  return { value, index: match.index };
}

function parseCurrencyNumber(raw, currency) {
  const negative = /-/.test(raw);
  let cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return NaN;
  let value;
  if (currency === "VND") {
    value = Number(cleaned.replace(/[.,]/g, ""));
  } else {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
    value = Number(cleaned);
  }
  return negative ? -value : value;
}

function isUsefulReceiptLabel(label) {
  if (!label || label.length < 2 || !/[a-z]/i.test(label)) return false;
  if (/^\d+[\d\s:./-]*$/.test(label)) return false;
  const normalized = label.toLowerCase();
  const lettersOnly = normalized.replace(/[^a-z]/g, "");
  const noise =
    /(subtotal|sub total|total|balance|amount due|cash|change|paid|payment|card|visa|mastercard|amex|auth|approved|merchant|terminal|invoice|check|receipt|table|server|cashier|operator|register|order|qty|quantity|guest|customer|phone|tel|address|www|http|email|tax id|tin|vat no|date|time|thank|welcome|copy|sale|dine in|drive thru|thru|takeout|take away|transaction|tran seq|approval|restroom|door code|university|merchant|aid|app)/i;
  if (noise.test(normalized)) return false;
  if (/(order|urder|numbe|numbel|numbei|transaction|register|cashier|operator|approval|restroom|mastercard|customer|welcome|pleasure|serving|university|tempe)/i.test(lettersOnly)) return false;
  const digitCount = (label.match(/\d/g) || []).length;
  if (digitCount > Math.max(2, label.length / 3)) return false;
  return true;
}

function cleanItemName(label) {
  return label
    .replace(/^\d+\s+/, "")
    .replace(/\b\d+\s*[xX@]\s*\d+(?:[.,]\d{1,2})?\b/g, "")
    .replace(/\b(?:ea|each)\b/gi, "")
    .replace(/\s+\.\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyFoodItem(label, amount, currency) {
  if (amount <= 0) return false;
  const maxItemAmount = { USD: 1000, THB: 50000, VND: 10000000 }[currency] || 1000;
  if (Math.abs(amount) > maxItemAmount) return false;
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 7) return false;
  if (label.length > 48) return false;
  return true;
}

function seedManualRows() {
  setTodayIfBlank();
  $("#manualItems").innerHTML = "";
  addManualItem("", 1, "");
  addManualItem("", 1, "");
  addManualItem("", 1, "");
  renderManualReview();
}

function setTodayIfBlank() {
  if (!$("#manualDate").value) $("#manualDate").value = new Date().toISOString().slice(0, 10);
}

function addManualItem(name = "", qty = 1, price = "") {
  const id = createId();
  const row = browserDocument.createElement("article");
  row.className = "manual-row";
  row.dataset.manualItem = id;
  row.innerHTML = `
    <div class="manual-name-line">
      <label>
        <span>Item name *</span>
        <input data-field="name" type="text" value="${escapeHtml(name)}" placeholder="Item name" />
      </label>
      <button data-remove-manual="${id}" aria-label="Remove item"><i data-lucide="trash-2"></i></button>
    </div>
    <div class="field-grid two">
      <label>
        <span>Qty</span>
        <input data-field="qty" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(qty)}" />
      </label>
      <label>
        <span>Unit price *</span>
        <input data-field="price" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(price)}" />
      </label>
    </div>
    <div class="line-total"><span>Line total</span><strong>$0.00</strong></div>
  `;
  $("#manualItems").appendChild(row);
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", renderManualReview));
  row.querySelector("[data-remove-manual]").addEventListener("click", () => {
    row.remove();
    if (!$$(".manual-row").length) addManualItem();
    renderManualReview();
  });
  renderManualReview();
  makeIcons();
}

function getManualDraft() {
  const rows = $$(".manual-row").map((row) => {
    const name = row.querySelector('[data-field="name"]').value.trim();
    const qty = Number(row.querySelector('[data-field="qty"]').value || 0);
    const price = Number(row.querySelector('[data-field="price"]').value || 0);
    const touched = Boolean(name || row.querySelector('[data-field="price"]').value || row.querySelector('[data-field="qty"]').value !== "1");
    const incomplete = touched && (!name || price <= 0);
    return { row, name, qty, price, touched, incomplete, total: qty * price };
  });
  const items = rows
    .map((row) => {
      return row;
    })
    .filter((item) => item.name && item.qty > 0 && item.price > 0);
  const tip = Number($("#manualTip").value || 0);
  const tax = Number($("#manualTax").value || 0);
  const fees = Number($("#manualFees").value || 0);
  const discount = Number($("#manualDiscount").value || 0);
  return { items, incompleteRows: rows.filter((row) => row.incomplete), tip, tax, fees, discount };
}

function renderManualReview() {
  const draft = getManualDraft();
  $$(".manual-row").forEach((row) => {
    const qty = Number(row.querySelector('[data-field="qty"]').value || 0);
    const price = Number(row.querySelector('[data-field="price"]').value || 0);
    row.querySelector(".line-total strong").textContent = formatNative(qty * price, $("#receiptCurrency").value);
  });
  const subtotal = sum(draft.items.map((item) => item.total));
  const total = Math.max(0, subtotal + draft.tip + draft.tax + draft.fees - draft.discount);
  $("#manualReview").innerHTML = `
    <div><span>Subtotal</span><strong>${formatNative(subtotal, $("#receiptCurrency").value)}</strong></div>
    <div><span>Tip</span><strong>${formatNative(draft.tip, $("#receiptCurrency").value)}</strong></div>
    <div><span>Tax</span><strong>${formatNative(draft.tax, $("#receiptCurrency").value)}</strong></div>
    <div><span>Fees</span><strong>${formatNative(draft.fees, $("#receiptCurrency").value)}</strong></div>
    <div><span>Discount</span><strong>-${formatNative(draft.discount, $("#receiptCurrency").value)}</strong></div>
    <div class="review-total"><span>Total</span><strong>${formatNative(total, $("#receiptCurrency").value)}</strong></div>
  `;
}

function buildManualReceipt() {
  const draft = getManualDraft();
  if (draft.incompleteRows.length) {
    safeAlert("Finish the item name and unit price for any row you started, or leave it blank.");
    return;
  }
  if (!draft.items.length) {
    safeAlert("Add at least one priced item.");
    return;
  }
  const fees = [];
  if (draft.tip > 0) fees.push({ id: createId(), name: "Tip", amount: draft.tip });
  if (draft.tax > 0) fees.push({ id: createId(), name: "Tax", amount: draft.tax });
  if (draft.fees > 0) fees.push({ id: createId(), name: "Fees", amount: draft.fees });
  parsedReceipt = {
    currency: $("#receiptCurrency").value,
    name: $("#manualName").value.trim() || "Dinner",
    date: $("#manualDate").value || new Date().toISOString().slice(0, 10),
    description: $("#manualDescription").value.trim(),
    source: "manual",
    imageDataUrl: "",
    restaurantName: "",
    items: draft.items.map((item) => ({
      id: createId(),
      name: item.name,
      amount: item.total,
      assignedTo: [],
    })),
    fees,
    discount: draft.discount,
  };
  splitMode = "items";
  setSplitMode("items");
  renderAssignment();
  showScreen("itemize");
}

function renderAssignment() {
  if (!parsedReceipt) return;
  syncReviewFields();
  renderReviewSummary();
  $("#itemizeTitle").textContent = parsedReceipt.name || "Receipt";
  renderReceiptTotals();
  $("#itemCountLabel").textContent = `${parsedReceipt.items.length} item${parsedReceipt.items.length === 1 ? "" : "s"}`;
  $("#evenPeopleLabel").textContent = `${splitCount} people`;
  $("#splitCount").textContent = splitCount;
  $("#saveLaterReceipt").classList.toggle("hidden", Boolean(editingReceiptId) || splitMode === "even");
  $("#itemizeReceiptPreview").classList.toggle("hidden", !parsedReceipt.imageDataUrl);
  if (parsedReceipt.imageDataUrl) {
    $("#itemizeReceiptImage").src = parsedReceipt.imageDataUrl;
  } else {
    $("#itemizeReceiptImage").removeAttribute("src");
  }
  const payer = findPerson(parsedReceipt.paidBy || $("#reviewPaidBy").value);
  $("#parsedPaidBy").textContent = payer ? `${payer.name} paid for this tab` : "";
  renderEvenPeopleList();
  renderAmountSplitList();

  $("#itemsList").innerHTML = parsedReceipt.items.length
    ? parsedReceipt.items
        .map(
          (item) => `
            <article class="item-row">
              <button class="delete-item" data-delete-item="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">
                <i data-lucide="trash-2"></i>
              </button>
              <div class="item-head">
                <div class="parsed-item-fields">
                  <label>
                    <span>Item</span>
                    <input data-edit-item-name="${item.id}" type="text" value="${escapeHtml(item.name)}" />
                  </label>
                  <label class="currency-input">
                    <span>Amount</span>
                    <em>${currencySymbol(parsedReceipt.currency)}</em>
                    <input data-edit-item-amount="${item.id}" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(item.amount)}" />
                  </label>
                </div>
              </div>
              <div class="chip-grid">
                ${state.people
                  .map(
                    (person) => `
                      <label class="chip">
                        <input type="checkbox" data-item="${item.id}" data-person="${person.id}" ${item.assignedTo?.includes(person.id) ? "checked" : ""}>
                        <span>${escapeHtml(person.name)}</span>
                      </label>
                    `
                  )
                  .join("")}
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty">No priced food items found.</div>`;

  renderFeesList();

  $$("[data-item]").forEach((box) => {
    box.addEventListener("change", updateSelectionBar);
  });
  $$("[data-delete-item]").forEach((button) => {
    button.addEventListener("click", () => deleteParsedItem(button.dataset.deleteItem));
  });
  $$("[data-edit-item-name]").forEach((input) => {
    input.addEventListener("change", () => updateParsedItem(input.dataset.editItemName));
  });
  $$("[data-edit-item-amount]").forEach((input) => {
    input.addEventListener("change", () => updateParsedItem(input.dataset.editItemAmount));
  });
  makeIcons();
  updateSelectionBar();
}

function syncReviewFields() {
  if (!parsedReceipt) return;
  setReviewValue("reviewName", parsedReceipt.name || "");
  setReviewValue("reviewCurrency", parsedReceipt.currency || "USD");
  if (parsedReceipt.paidBy) $("#reviewPaidBy").value = parsedReceipt.paidBy;
  else if (activePersonId && state.people.some((person) => person.id === activePersonId)) $("#reviewPaidBy").value = activePersonId;
  setReviewValue("reviewDate", parsedReceipt.date || "");
  setReviewValue("reviewNotes", parsedReceipt.description || "");
  setReviewValue("reviewTip", adjustmentAmount("tip"));
  setReviewValue("reviewTax", adjustmentAmount("tax"));
  setReviewValue("reviewFees", adjustmentAmount("fees"));
  setReviewValue("reviewDiscount", parsedReceipt.discount || 0);
}

function renderReceiptTotals() {
  if (!parsedReceipt) return;
  const total = receiptTotal(parsedReceipt);
  const evenCount = splitMode === "even" ? Math.max(1, splitEvenPeople.length || splitCount) : splitCount;
  $("#parsedTotal").textContent = formatNative(total, parsedReceipt.currency);
  $("#splitEachLabel").textContent = `${formatNative(total / evenCount, parsedReceipt.currency)} each`;
  $("#saveReceiptLabel").textContent = splitMode === "even" ? `Review ${formatNative(total, parsedReceipt.currency)}` : "Review selections";
}

function renderFeesList() {
  if (!parsedReceipt) return;
  const rows = [
    ...parsedReceipt.fees.map(
      (fee) => `<div class="fee-row"><span>${escapeHtml(fee.name)}</span><strong>${formatNative(fee.amount, parsedReceipt.currency)}</strong></div>`
    ),
    parsedReceipt.discount
      ? `<div class="fee-row"><span>Discount</span><strong>-${formatNative(parsedReceipt.discount, parsedReceipt.currency)}</strong></div>`
      : "",
  ].filter(Boolean);
  $("#feesList").innerHTML = rows.length
    ? rows.join("")
    : `<div class="fee-row"><span>No separate tip, tax, or fees</span><strong>${formatNative(0, parsedReceipt.currency)}</strong></div>`;
}

function renderReviewSummary() {
  if (!parsedReceipt) return;
  const payer = findPerson(parsedReceipt.paidBy || $("#reviewPaidBy").value)?.name || "Not set";
  $("#reviewSummary").innerHTML = `
    <div><span>Name</span><strong>${escapeHtml(parsedReceipt.name || "Receipt")}</strong></div>
    <div><span>Date</span><strong>${escapeHtml(formatLongDate(parsedReceipt.date) || "Not set")}</strong></div>
    <div><span>Paid by</span><strong>${escapeHtml(payer)}</strong></div>
    <div><span>Currency</span><strong>${escapeHtml(parsedReceipt.currency || "USD")}</strong></div>
    <div><span>Tip / tax / fees</span><strong>${formatNative(sum(parsedReceipt.fees.map((fee) => fee.amount)), parsedReceipt.currency)}</strong></div>
    <div><span>Discount</span><strong>${formatNative(parsedReceipt.discount || 0, parsedReceipt.currency)}</strong></div>
    ${parsedReceipt.description ? `<div><span>Notes</span><strong>${escapeHtml(parsedReceipt.description)}</strong></div>` : ""}
  `;
}

function setReviewValue(id, value) {
  const input = $(`#${id}`);
  if (browserDocument?.activeElement === input) return;
  input.value = value;
}

function updateParsedDetails() {
  if (!parsedReceipt) return;
  parsedReceipt.name = $("#reviewName").value.trim() || "Receipt";
  parsedReceipt.date = $("#reviewDate").value || new Date().toISOString().slice(0, 10);
  parsedReceipt.description = $("#reviewNotes").value.trim();
  $("#itemizeTitle").textContent = parsedReceipt.name;
  renderReviewSummary();
}

function updateParsedCurrency() {
  if (!parsedReceipt) return;
  parsedReceipt.currency = $("#reviewCurrency").value;
  renderAssignment();
}

function updateParsedAdjustments() {
  if (!parsedReceipt) return;
  setAdjustmentAmount("tip", Number($("#reviewTip").value || 0));
  setAdjustmentAmount("tax", Number($("#reviewTax").value || 0));
  setAdjustmentAmount("fees", Number($("#reviewFees").value || 0));
  parsedReceipt.discount = Number($("#reviewDiscount").value || 0);
  renderReceiptTotals();
  renderFeesList();
  renderReviewSummary();
}

function adjustmentAmount(type) {
  if (!parsedReceipt) return 0;
  return sum(parsedReceipt.fees.filter((fee) => adjustmentType(fee.name) === type).map((fee) => fee.amount));
}

function setAdjustmentAmount(type, amount) {
  const nextAmount = Math.max(0, amount);
  parsedReceipt.fees = parsedReceipt.fees.filter((fee) => adjustmentType(fee.name) !== type);
  if (nextAmount > 0) {
    parsedReceipt.fees.push({ id: createId(), name: adjustmentLabel(type), amount: nextAmount });
  }
}

function adjustmentType(name) {
  if (/tip|gratuity/i.test(name)) return "tip";
  if (/tax|vat|gst/i.test(name)) return "tax";
  return "fees";
}

function adjustmentLabel(type) {
  if (type === "tip") return "Tip";
  if (type === "tax") return "Tax";
  return "Fees";
}

function updateParsedItem(itemId) {
  if (!parsedReceipt) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item) return;
  const name = $(`[data-edit-item-name="${itemId}"]`)?.value.trim();
  const amount = Number($(`[data-edit-item-amount="${itemId}"]`)?.value || 0);
  item.name = name || "Item";
  item.amount = Math.max(0, amount);
  renderAssignment();
}

function addParsedItem() {
  if (!parsedReceipt) return;
  parsedReceipt.items.push({
    id: createId(),
    name: "New item",
    amount: 0,
    assignedTo: activePersonId ? [activePersonId] : [],
  });
  renderAssignment();
}

function deleteParsedItem(itemId) {
  if (!parsedReceipt) return;
  parsedReceipt.items = parsedReceipt.items.filter((item) => item.id !== itemId);
  renderAssignment();
}

function setSplitMode(mode) {
  splitMode = mode;
  $$(".method").forEach((button) => button.classList.toggle("active", button.dataset.splitMode === mode));
  $("#pickItemsPanel").classList.toggle("hidden", mode !== "items");
  $("#evenSplitPanel").classList.toggle("hidden", mode !== "even");
  $("#amountSplitPanel").classList.toggle("hidden", mode !== "amounts");
  renderAssignment();
}

function updateSplitCount(next) {
  splitCount = Math.max(1, Math.min(30, next));
  renderAssignment();
}

function renderEvenPeopleList() {
  if (!parsedReceipt) return;
  if (!splitEvenPeople.length) splitEvenPeople = state.people.map((person) => person.id);
  $("#evenPeopleList").innerHTML = state.people
    .map(
      (person) => `
        <label class="chip">
          <input type="checkbox" data-even-person="${person.id}" ${splitEvenPeople.includes(person.id) ? "checked" : ""}>
          <span>${escapeHtml(person.name)}</span>
        </label>
      `
    )
    .join("");
  $$("[data-even-person]").forEach((box) => {
    box.addEventListener("change", () => {
      splitEvenPeople = $$("[data-even-person]:checked").map((input) => input.dataset.evenPerson);
      splitCount = Math.max(1, splitEvenPeople.length);
      renderReceiptTotals();
      updateSelectionBar();
    });
  });
}

function renderAmountSplitList() {
  if (!parsedReceipt) return;
  const total = receiptTotal(parsedReceipt);
  $("#amountSplitList").innerHTML = state.people
    .map(
      (person) => `
        <label class="amount-row">
          <span>${escapeHtml(person.name)}</span>
          <input data-amount-person="${person.id}" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(amountForPerson(person.id))}" />
        </label>
      `
    )
    .join("");
  $$("[data-amount-person]").forEach((input) => {
    input.addEventListener("input", updateAmountRemaining);
  });
  $("#amountRemaining").textContent = `${formatNative(Math.max(0, total - assignedAmountTotal()), parsedReceipt.currency)} left`;
}

function amountForPerson(personId) {
  if (!parsedReceipt?.amountSplits) return "";
  const value = parsedReceipt.amountSplits[personId];
  return value ? roundCents(value) : "";
}

function assignedAmountTotal() {
  return sum($$("[data-amount-person]").map((input) => Number(input.value || 0)));
}

function updateAmountRemaining() {
  if (!parsedReceipt) return;
  const remaining = receiptTotal(parsedReceipt) - assignedAmountTotal();
  $("#amountRemaining").textContent = `${formatNative(Math.max(0, remaining), parsedReceipt.currency)} left`;
  updateSelectionBar();
}

function collectAssignmentChoices() {
  if (!parsedReceipt) return;
  parsedReceipt.items.forEach((item) => {
    item.assignedTo = $$(`input[data-item="${item.id}"]:checked`).map((box) => box.dataset.person);
  });
}

function selectedItemsForActivePerson() {
  if (!parsedReceipt) return [];
  const personId = activePersonId || $("#reviewPaidBy").value;
  return parsedReceipt.items.filter((item) => (item.assignedTo || []).includes(personId));
}

function selectedNativeTotal() {
  if (!parsedReceipt) return 0;
  if (splitMode === "even") return receiptTotal(parsedReceipt) / Math.max(1, splitEvenPeople.length || splitCount);
  if (splitMode === "amounts") return Number($(`[data-amount-person="${activePersonId || $("#reviewPaidBy").value}"]`)?.value || 0);
  return sum(selectedItemsForActivePerson().map((item) => item.amount)) + selectedAdjustmentShare();
}

function selectedAdjustmentShare() {
  if (!parsedReceipt) return 0;
  const selectedSubtotal = sum(selectedItemsForActivePerson().map((item) => item.amount));
  const subtotal = sum(parsedReceipt.items.map((item) => item.amount));
  if (!selectedSubtotal || !subtotal) return 0;
  return (sum(parsedReceipt.fees.map((fee) => fee.amount)) - (parsedReceipt.discount || 0)) * (selectedSubtotal / subtotal);
}

function updateSelectionBar() {
  if (!parsedReceipt) return;
  collectAssignmentChoices();
  const hasSelection = splitMode === "even" || splitMode === "amounts" || selectedItemsForActivePerson().length > 0;
  $("#selectionTotal").classList.toggle("hidden", !hasSelection);
  $("#reviewSelections").classList.toggle("hidden", !hasSelection);
  $("#saveLaterReceipt").classList.toggle("hidden", hasSelection || Boolean(editingReceiptId) || splitMode !== "items");
  $("#selectionTotal").textContent = `Selected ${formatNative(selectedNativeTotal(), parsedReceipt.currency)}`;
}

function reviewSelections() {
  if (!parsedReceipt) return;
  collectAssignmentChoices();
  const selector = findPerson(activePersonId || $("#reviewPaidBy").value)?.name || "Your";
  $("#selectionReviewTitle").textContent = `${possessive(selector)} selected items`;
  if (splitMode === "even") {
    const people = splitEvenPeople.length ? splitEvenPeople : state.people.map((person) => person.id);
    const nativeTotal = receiptTotal(parsedReceipt) / Math.max(1, people.length);
    $("#selectionReviewTotal").textContent = formatNative(nativeTotal, parsedReceipt.currency);
    $("#selectionReviewReceipt").textContent = `${parsedReceipt.name || "Receipt"} · split evenly`;
    $("#selectionReviewCount").textContent = `${people.length} people`;
    $("#selectionReviewList").innerHTML = `<div class="fee-row"><span>Your even share</span><strong>${formatNative(nativeTotal, parsedReceipt.currency)}</strong></div>${convertedLine(nativeTotal, parsedReceipt.currency)}`;
    showScreen("selection-review");
    return;
  }
  if (splitMode === "amounts") {
    const entries = $$("[data-amount-person]").map((input) => ({ personId: input.dataset.amountPerson, amount: Number(input.value || 0) })).filter((entry) => entry.amount > 0);
    parsedReceipt.amountSplits = Object.fromEntries(entries.map((entry) => [entry.personId, entry.amount]));
    const nativeTotal = parsedReceipt.amountSplits[activePersonId] || 0;
    $("#selectionReviewTotal").textContent = formatNative(nativeTotal, parsedReceipt.currency);
    $("#selectionReviewReceipt").textContent = `${parsedReceipt.name || "Receipt"} · specific amounts`;
    $("#selectionReviewCount").textContent = `${entries.length} people`;
    $("#selectionReviewList").innerHTML = entries
      .map((entry) => `<div class="fee-row"><span>${escapeHtml(findPerson(entry.personId)?.name || "Guest")}</span><strong>${formatNative(entry.amount, parsedReceipt.currency)}</strong></div>`)
      .join("") + convertedLine(nativeTotal, parsedReceipt.currency);
    showScreen("selection-review");
    return;
  }
  const items = selectedItemsForActivePerson();
  if (!items.length) return;
  const adjustment = selectedAdjustmentShare();
  $("#selectionReviewTotal").textContent = formatNative(selectedNativeTotal(), parsedReceipt.currency);
  $("#selectionReviewReceipt").textContent = parsedReceipt.name || "Receipt";
  $("#selectionReviewCount").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
  const nativeTotal = selectedNativeTotal();
  $("#selectionReviewList").innerHTML = [
    ...items.map((item) => `<div class="fee-row"><span>${escapeHtml(item.name)}</span><strong>${formatNative(item.amount, parsedReceipt.currency)}</strong></div>`),
    adjustment ? `<div class="fee-row"><span>Tip, tax, fees, discounts</span><strong>${formatNative(adjustment, parsedReceipt.currency)}</strong></div>` : "",
    convertedLine(nativeTotal, parsedReceipt.currency),
  ]
    .filter(Boolean)
    .join("");
  showScreen("selection-review");
}

function convertedLine(amount, currency) {
  if (currency === "USD") return "";
  return `<div class="fee-row"><span>Converted total</span><strong>${money.format(toUsd(amount, currency))}</strong></div>`;
}

function saveReceipt(assignLater = false, directToExpenses = false) {
  if (!parsedReceipt) return;
  const paidBy = $("#reviewPaidBy").value;
  if (!paidBy) {
    safeAlert("Add at least one person and choose who paid.");
    return;
  }

  if (assignLater) {
    parsedReceipt.items.forEach((item) => {
      item.assignedTo = [];
    });
    parsedReceipt.splitEvenCount = null;
  } else if (splitMode === "even") {
    const people = splitEvenPeople.length ? splitEvenPeople : state.people.map((person) => person.id);
    parsedReceipt.items.forEach((item) => {
      item.assignedTo = people;
    });
    parsedReceipt.splitEvenCount = people.length;
  } else if (splitMode === "amounts") {
    parsedReceipt.amountSplits = Object.fromEntries($$("[data-amount-person]").map((input) => [input.dataset.amountPerson, Number(input.value || 0)]));
    parsedReceipt.items = Object.entries(parsedReceipt.amountSplits)
      .filter(([, amount]) => amount > 0)
      .map(([personId, amount]) => ({
        id: createId(),
        name: `Share - ${findPerson(personId)?.name || "Guest"}`,
        amount,
        assignedTo: [personId],
      }));
    parsedReceipt.fees = [];
    parsedReceipt.discount = 0;
  } else {
    collectAssignmentChoices();
    if (!parsedReceipt.items.some((item) => item.assignedTo.length > 0)) {
      safeAlert("Select at least one item to log.");
      return;
    }
  }

  const savedSplitMode = assignLater ? "items" : splitMode;
  const shares = assignLater
    ? withUsd(emptyPersonMap(), parsedReceipt.currency)
    : splitMode === "even"
      ? calculateEvenShares(parsedReceipt, splitEvenPeople.length || splitCount)
      : splitMode === "amounts"
        ? calculateAmountShares(parsedReceipt)
        : calculateItemShares(parsedReceipt);
  const receipt = {
    id: editingReceiptId || createId(),
    createdAt: new Date().toISOString(),
    currency: parsedReceipt.currency,
    name: parsedReceipt.name,
    date: parsedReceipt.date,
    location: parsedReceipt.location,
    description: parsedReceipt.description,
    restaurantName: parsedReceipt.restaurantName || "",
    imageDataUrl: parsedReceipt.imageDataUrl || "",
    paidBy,
    splitMode: savedSplitMode,
    splitCount: assignLater ? null : splitCount,
    assignmentStatus: assignLater || parsedReceipt.items.some((item) => !item.assignedTo.length) ? "pending" : "complete",
    items: parsedReceipt.items,
    fees: parsedReceipt.fees,
    discount: parsedReceipt.discount || 0,
    shares,
    totalNative: receiptTotal(parsedReceipt),
    totalUsd: toUsd(receiptTotal(parsedReceipt), parsedReceipt.currency),
    rateUsed: rates.rates[parsedReceipt.currency] || 1,
  };

  if (editingReceiptId) {
    state.receipts = state.receipts.map((existing) => (existing.id === editingReceiptId ? receipt : existing));
  } else {
    state.receipts.unshift(receipt);
  }
  parsedReceipt = null;
  editingReceiptId = null;
  saveState();
  saveGroupReceipt(receipt);
  render();
  if (directToExpenses && !assignLater) showScreen("expenses");
  else showConfirmation(receipt, assignLater);
}

function calculateItemShares(receipt) {
  const native = emptyPersonMap();
  receipt.items.forEach((item) => {
    const split = item.amount / item.assignedTo.length;
    item.assignedTo.forEach((personId) => {
      native[personId] += split;
    });
  });

  const subtotal = sum(Object.values(native));
  const adjustments = sum(receipt.fees.map((fee) => fee.amount)) - (receipt.discount || 0);
  if (subtotal > 0 && adjustments !== 0) {
    Object.keys(native).forEach((personId) => {
      native[personId] += adjustments * (native[personId] / subtotal);
    });
  }
  return withUsd(native, receipt.currency);
}

function calculateEvenShares(receipt, peopleCount) {
  const native = emptyPersonMap();
  const total = receiptTotal(receipt);
  const personIds = splitEvenPeople.length ? splitEvenPeople : state.people.slice(0, peopleCount).map((person) => person.id);
  personIds.forEach((personId) => {
    native[personId] = total / personIds.length;
  });
  return withUsd(native, receipt.currency);
}

function calculateAmountShares(receipt) {
  const native = emptyPersonMap();
  Object.entries(receipt.amountSplits || {}).forEach(([personId, amount]) => {
    native[personId] = Number(amount || 0);
  });
  return withUsd(native, receipt.currency);
}

function emptyPersonMap() {
  const native = {};
  state.people.forEach((person) => {
    native[person.id] = 0;
  });
  return native;
}

function withUsd(native, currency) {
  const usd = {};
  Object.keys(native).forEach((personId) => {
    usd[personId] = toUsd(native[personId], currency);
  });
  return { native, usd };
}

function receiptTotal(receipt) {
  return Math.max(0, sum(receipt.items.map((item) => item.amount)) + sum(receipt.fees.map((fee) => fee.amount)) - (receipt.discount || 0));
}

function toUsd(amount, currency) {
  const rate = rates.rates[currency] || 1;
  return currency === "USD" ? amount : amount / rate;
}

function render() {
  renderGroupUi();
  renderGroups();
  renderPeopleOptions();
  renderPeople();
  renderPendingReceipts();
  renderTotals();
  renderHistory();
  renderSettlements();
  renderSummary();
  renderManualReview();
  renderExpenses();
  makeIcons();
}

function renderGroupUi() {
  const signedIn = Boolean(activeGroupId && activePersonId && activeGroup);
  $("#resetApp").classList.add("hidden");
  $("#closeTrip").classList.add("hidden");
  $("#homeGroupSetup").classList.toggle("hidden", signedIn);
  $("#homeTripTitle").textContent = activeGroup?.name || "Group expenses";
  const closed = isTripClosed();
  $(".action-panel")?.classList.toggle("hidden", closed);
  $("#settlementList")?.closest(".panel")?.classList.toggle("settle-focus", closed);
  $("#groupSignedOut").classList.toggle("hidden", signedIn);
  $("#groupSignedIn").classList.toggle("hidden", !signedIn);
  if (!signedIn) {
    $("#groupTitle").textContent = "Trip group";
    $("#groupStatus").textContent = activeGroupId ? "Join required" : "Local only";
    return;
  }
  const person = findPerson(activePersonId);
  $("#groupTitle").textContent = activeGroup.name || "Trip group";
  $("#groupStatus").textContent = "Shared";
  $("#memberNameLabel").textContent = `Signed in as ${person?.name || "Guest"}`;
  $("#inviteLink").value = inviteUrl();
  $("#resetApp").classList.toggle("hidden", !isTripOwner());
  $("#closeTrip").classList.toggle("hidden", !isTripOwner());
}

function isTripClosed() {
  return readStorage(`trip-split-closed-${activeGroupId}`) === "true";
}

function closeTrip() {
  if (!activeGroupId || !isTripOwner()) return;
  if (!safeConfirm("Close this trip for settlement?")) return;
  writeStorage(`trip-split-closed-${activeGroupId}`, "true");
  render();
  showScreen("settle");
}

function leaveTrip() {
  if (!activeGroupId || !activePersonId) return;
  if (!safeConfirm("Leave this trip on this device?")) return;
  if (!safeConfirm("Are you sure? You will need the invite link to rejoin.")) return;
  removeStorage(`trip-split-person-${activeGroupId}`);
  removeStorage("trip-split-group-id");
  activePersonId = "";
  activeGroupId = "";
  activeGroup = null;
  state = defaultState();
  render();
  showScreen("groups");
}

function renderInstallScreen() {
  $("#installInviteLink").value = activeGroupId ? inviteUrl() : `${location.origin}/start`;
  $("#installInvitePanel").classList.toggle("hidden", !isTripOwner());
  $("#installBack").classList.toggle("hidden", installReturnScreen === "home");
  $("#installPromptText").textContent = /iphone|ipad/i.test(navigator.userAgent)
    ? "Tap Share in Safari, then Add to Home Screen."
    : "Use Add app when available, or install Trip Split from your browser menu.";
}

function renderGroups() {
  const groups = loadKnownGroups();
  $("#groupsList").innerHTML = groups.length
    ? groups
        .map(
          (group) => `
            <article class="group-row ${group.id === activeGroupId ? "active" : ""}">
              <div>
                <div class="row-name">${escapeHtml(group.name)}</div>
                <div class="subtext">${group.id === activeGroupId ? "Current trip" : "Tap to switch"}</div>
              </div>
              ${group.id === activeGroupId ? "" : `<button class="small-primary" data-switch-group="${group.id}"><i data-lucide="arrow-right"></i><span>Open</span></button>`}
            </article>
          `
        )
        .join("")
    : `<div class="empty">Create or join a trip to see it here.</div>`;

  $$("[data-switch-group]").forEach((button) => {
    button.addEventListener("click", () => switchGroup(button.dataset.switchGroup));
  });
}

async function switchGroup(groupId) {
  const known = loadKnownGroups().find((group) => group.id === groupId);
  if (!known) return;
  activeGroupId = groupId;
  activePersonId = known.personId || readStorage(`trip-split-person-${groupId}`) || "";
  writeStorage("trip-split-group-id", groupId);
  if (activePersonId) writeStorage(`trip-split-person-${groupId}`, activePersonId);
  await initGroup();
  render();
  showScreen(activePersonId ? "home" : "join");
}

function renderPeopleOptions() {
  const options = state.people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("");
  $("#paidBy").innerHTML = options;
  $("#reviewPaidBy").innerHTML = options;
  if (activePersonId && state.people.some((person) => person.id === activePersonId)) {
    $("#paidBy").value = activePersonId;
    $("#reviewPaidBy").value = activePersonId;
  }
  splitCount = Math.max(1, Math.min(splitCount, state.people.length || 1));
}

function renderPeople() {
  const admin = isTripOwner();
  $("#peopleList").innerHTML = state.people.length
    ? state.people
        .map(
          (person) => {
            const canRemove = admin || person.id === activePersonId;
            return `
            <div class="person-row">
              <div>
                <div class="row-name">${escapeHtml(person.name)}</div>
                <div class="subtext">${personTotals(person.id).receiptCount} receipts shared</div>
              </div>
              ${
                canRemove
                  ? `<button aria-label="Remove ${escapeHtml(person.name)}" data-remove-person="${person.id}">
                <i data-lucide="trash-2"></i>
              </button>`
                  : ""
              }
            </div>
          `;
          }
        )
        .join("")
    : `<div class="empty">Add people before saving a receipt.</div>`;

  $$("[data-remove-person]").forEach((button) => {
    button.addEventListener("click", () => removePerson(button.dataset.removePerson));
  });
}

function isTripOwner() {
  return Boolean(activeGroupId && activePersonId && readStorage(`trip-split-owner-${activeGroupId}`) === activePersonId);
}

function removePerson(personId) {
  const used = state.receipts.some(
    (receipt) => receipt.paidBy === personId || Object.keys(receipt.shares.usd).some((id) => id === personId && receipt.shares.usd[id] > 0)
  );
  if (used) {
    safeAlert("This person is already in a receipt. Reset the trip to remove them.");
    return;
  }
  state.people = state.people.filter((person) => person.id !== personId);
  saveState();
  render();
}

function renderTotals() {
  const balances = calculateBalances();
  $("#totalsList").innerHTML = state.people.length
    ? state.people
        .map((person) => {
          const totals = personTotals(person.id);
          const balance = balances[person.id] || 0;
          return `
            <div class="total-row">
              <div>
                <div class="row-name">${escapeHtml(person.name)}</div>
                <div class="subtext">${possessive(person.name)} share ${money.format(totals.owed)} · Paid ${money.format(totals.paid)}</div>
              </div>
              <div class="money ${balance >= 0 ? "positive" : "negative"}">${money.format(balance)}</div>
            </div>
          `;
        })
        .join("")
    : `<div class="empty">No people yet.</div>`;
}

function renderHistory() {
  $("#historyCount").textContent = `${state.receipts.length}`;
  const sortedReceipts = [...state.receipts].sort((a, b) => {
    const sort = $("#receiptSort")?.value || "entry";
    const aDate = sort === "receipt" ? a.date || a.createdAt : a.createdAt || a.date;
    const bDate = sort === "receipt" ? b.date || b.createdAt : b.createdAt || b.date;
    return new Date(bDate || 0) - new Date(aDate || 0);
  });
  $("#historyList").innerHTML = sortedReceipts.length
    ? sortedReceipts
        .map((receipt) => {
          const payer = findPerson(receipt.paidBy)?.name || "Unknown";
          const date = new Date(receipt.date || receipt.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return `
            <article class="history-row">
              <div class="row-head">
                <div>
                  <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                  <div class="subtext">${payer} paid · ${date} · ${isPendingReceipt(receipt) ? "needs splitting" : receipt.splitMode === "even" ? "split evenly" : `${receipt.items.length} items`}</div>
                </div>
                <div class="money">${money.format(receipt.totalUsd)}</div>
              </div>
              <div class="subtext">Original ${formatNative(receipt.totalNative, receipt.currency)} · ${formatRate(receipt.currency, receipt.rateUsed)}</div>
              ${receipt.imageDataUrl ? `<button class="receipt-thumb history-thumb" data-preview-receipt="${receipt.id}" aria-label="Open ${escapeHtml(receipt.name || "Receipt")} photo"><img src="${receipt.imageDataUrl}" alt="${escapeHtml(receipt.name || "Receipt")} photo" loading="lazy" /></button>` : ""}
              ${
                receipt.splitMode === "items"
                  ? `<button class="small-primary receipt-open" data-open-receipt="${receipt.id}"><i data-lucide="list-checks"></i><span>${isPendingReceipt(receipt) ? "Split now" : "Edit items"}</span></button>`
                  : ""
              }
            </article>
          `;
        })
        .join("")
    : `<div class="empty">Saved receipts will appear here.</div>`;

  $$("[data-open-receipt]").forEach((button) => {
    button.addEventListener("click", () => openReceiptForClaiming(button.dataset.openReceipt));
  });
  $$("[data-preview-receipt]").forEach((button) => {
    button.addEventListener("click", () => openSavedReceiptImagePreview(button.dataset.previewReceipt));
  });
}

function renderPendingReceipts() {
  const pending = state.receipts.filter(isPendingReceipt);
  $("#pendingPanel").classList.toggle("hidden", pending.length === 0);
  $("#pendingCount").textContent = `${pending.length}`;
  $("#pendingList").innerHTML = pending.length
    ? pending
        .map((receipt) => {
          const payer = findPerson(receipt.paidBy)?.name || "Someone";
          return `
            <article class="pending-row">
              <div>
                <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                <div class="subtext">${payer} paid ${formatNative(receipt.totalNative, receipt.currency)} · ${unassignedItemCount(receipt)} items left</div>
              </div>
              <button class="small-primary" data-open-pending="${receipt.id}"><i data-lucide="list-checks"></i><span>Split</span></button>
            </article>
          `;
        })
        .join("")
    : "";

  $$("[data-open-pending]").forEach((button) => {
    button.addEventListener("click", () => openReceiptForClaiming(button.dataset.openPending));
  });
}

function isPendingReceipt(receipt) {
  return unassignedItemCount(receipt) > 0;
}

function unassignedItemCount(receipt) {
  return (receipt.items || []).filter((item) => !(item.assignedTo || []).length).length;
}

function openReceiptForClaiming(receiptId) {
  const receipt = state.receipts.find((item) => item.id === receiptId);
  if (!receipt) return;
  editingReceiptId = receipt.id;
  parsedReceipt = JSON.parse(JSON.stringify(receipt));
  parsedReceipt.paidBy = receipt.paidBy;
  splitMode = "items";
  setSplitMode("items");
  renderAssignment();
  showScreen("itemize");
}

function renderSettlements() {
  const settlements = calculateSettlements();
  const balance = calculateBalances()[activePersonId] || 0;
  $("#mySettlementBalance").textContent = money.format(Math.abs(balance));
  $("#mySettlementHint").textContent = balance > 0.005 ? "You are owed" : balance < -0.005 ? "You owe" : "You are settled up";
  const settledIds = settledSettlementIds();
  const active = settlements.filter((settlement) => !settledIds.includes(settlement.id));
  const archived = settlements.filter((settlement) => settledIds.includes(settlement.id));
  $("#settlementList").innerHTML = [
    active.length
      ? active
        .map(
          (settlement) => `
            <div class="settle-row">
              <div>
                <div class="row-name">${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</div>
                <div class="subtext">Final net settlement</div>
              </div>
              <div class="settle-actions">
                <div class="money">${money.format(settlement.amount)}</div>
                <button class="small-primary" data-settle="${settlement.id}"><span>Settled</span></button>
              </div>
            </div>
          `
        )
        .join("")
      : `<div class="empty">Everyone is even once receipts are added and assigned.</div>`,
    archived.length
      ? `<details class="settled-archive"><summary>Settled archive (${archived.length})</summary>${archived
          .map(
            (settlement) => `
              <div class="settle-row">
                <div>
                  <div class="row-name">${escapeHtml(settlement.from)} paid ${escapeHtml(settlement.to)}</div>
                  <div class="subtext">Archived settlement</div>
                </div>
                <div class="settle-actions">
                  <div class="money">${money.format(settlement.amount)}</div>
                  <button class="small-primary" data-unsettle="${settlement.id}"><span>Unsettle</span></button>
                </div>
              </div>
            `
          )
          .join("")}</details>`
      : "",
  ].join("");
  $$("[data-settle]").forEach((button) => button.addEventListener("click", () => markSettlement(button.dataset.settle, true)));
  $$("[data-unsettle]").forEach((button) => button.addEventListener("click", () => markSettlement(button.dataset.unsettle, false)));
}

function settledSettlementIds() {
  const saved = readStorage(`trip-split-settled-${activeGroupId}`) || "[]";
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
}

function markSettlement(id, settled) {
  const ids = new Set(settledSettlementIds());
  if (settled) ids.add(id);
  else ids.delete(id);
  writeStorage(`trip-split-settled-${activeGroupId}`, JSON.stringify([...ids]));
  renderSettlements();
}

function renderSummary() {
  $("#tripTotal").textContent = money.format(sum(state.receipts.map((receipt) => receipt.totalUsd)));
  $("#receiptCount").textContent = `${state.receipts.length}`;
  const personId = activePersonId || state.people[0]?.id;
  const person = findPerson(personId);
  const totals = personId ? personTotals(personId) : { owed: 0 };
  $("#loggedInAs").textContent = person ? `Logged in as ${person.name}` : "Not signed in";
  $("#personalTotal").textContent = `${person ? possessive(person.name) : "Your"} share ${money.format(totals.owed)}`;
}

function renderExpenses() {
  const personId = activePersonId || state.people[0]?.id;
  const person = findPerson(personId);
  const rows = [];
  let total = 0;
  state.receipts.forEach((receipt) => {
    if (isPendingReceipt(receipt)) return;
    const items = (receipt.items || []).filter((item) => (item.assignedTo || []).includes(personId));
    if (!items.length) return;
    const native = items.reduce((sumValue, item) => sumValue + item.amount / Math.max(1, item.assignedTo.length), 0);
    total += toUsd(native, receipt.currency);
    rows.push({ receipt, items, native });
  });
  $("#expensesTitle").textContent = person ? `${possessive(person.name)} expenses` : "My expenses";
  $("#expensesTotal").textContent = money.format(total);
  $("#expensesList").innerHTML = rows.length
    ? rows
        .map(
          ({ receipt, items, native }) => `
            <article class="history-row">
              <div class="row-head">
                <div>
                  <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                  <div class="subtext">${new Date(receipt.date || receipt.createdAt).toLocaleDateString()}</div>
                </div>
                <div class="money">${formatNative(native, receipt.currency)}</div>
              </div>
              <details class="settled-archive">
                <summary>${items.length} item${items.length === 1 ? "" : "s"}</summary>
                ${items.map((item) => `<div class="fee-row"><span>${escapeHtml(item.name)}</span><strong>${formatNative(item.amount / Math.max(1, item.assignedTo.length), receipt.currency)}</strong></div>`).join("")}
              </details>
            </article>
          `
        )
        .join("")
    : `<div class="empty">Your accepted expenses will appear here.</div>`;
}

function personTotals(personId) {
  let owed = 0;
  let paid = 0;
  let receiptCount = 0;
  state.receipts.forEach((receipt) => {
    if (isPendingReceipt(receipt)) return;
    const share = receipt.shares.usd[personId] || 0;
    owed += share;
    if (share > 0) receiptCount += 1;
    if (receipt.paidBy === personId) paid += receipt.totalUsd;
  });
  return { owed, paid, receiptCount };
}

function calculateBalances() {
  const balances = {};
  state.people.forEach((person) => {
    const totals = personTotals(person.id);
    balances[person.id] = roundCents(totals.paid - totals.owed);
  });
  return balances;
}

function calculateSettlements() {
  const balances = calculateBalances();
  const debtors = [];
  const creditors = [];

  state.people.forEach((person) => {
    const amount = roundCents(balances[person.id] || 0);
    if (amount < -0.005) debtors.push({ person, amount: Math.abs(amount) });
    if (amount > 0.005) creditors.push({ person, amount });
  });

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = roundCents(Math.min(debtor.amount, creditor.amount));
    if (amount > 0) settlements.push({ id: `${debtor.person.id}-${creditor.person.id}-${amount}`, from: debtor.person.name, to: creditor.person.name, amount });
    debtor.amount = roundCents(debtor.amount - amount);
    creditor.amount = roundCents(creditor.amount - amount);
    if (debtor.amount <= 0.005) debtorIndex += 1;
    if (creditor.amount <= 0.005) creditorIndex += 1;
  }
  return settlements;
}

function showConfirmation(receipt, assignedLater) {
  $("#confirmationKicker").textContent = assignedLater ? "Saved for splitting later" : "Saved to trip";
  $("#confirmationTitle").textContent = receipt.name || "Receipt";
  $("#confirmationDetail").textContent = `${formatNative(receipt.totalNative, receipt.currency)} logged${assignedLater ? " · pending item assignments" : ""}`;
  showScreen("confirmation");
  if (!assignedLater && isBrowser) {
    window.setTimeout(() => showScreen("expenses"), 1200);
  }
}

function findPerson(personId) {
  return state.people.find((person) => person.id === personId);
}

function formatNative(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: currency === "VND" ? 0 : 2,
    maximumFractionDigits: currency === "VND" ? 0 : 2,
  }).format(amount || 0);
}

function currencySymbol(currency) {
  if (currency === "THB") return "฿";
  if (currency === "VND") return "₫";
  return "$";
}

function formatRate(currency, rate) {
  if (currency === "USD") return "1 USD";
  return `1 USD = ${Number(rate).toLocaleString("en-US", { maximumFractionDigits: currency === "VND" ? 0 : 2 })} ${currency}`;
}

function formatLongDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function possessive(name) {
  const clean = String(name || "Your").trim();
  if (!clean || clean.toLowerCase() === "your") return "Your";
  return `${clean}${clean.endsWith("s") ? "'" : "'s"}`;
}

async function promptInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    showScreen(installReturnScreen);
    return;
  }
  $("#installPromptText").textContent = /iphone|ipad/i.test(navigator.userAgent)
    ? "Tap Share in Safari, then Add to Home Screen."
    : "Open your browser menu and choose Install app or Add to Home Screen.";
}

function downloadAllReceipts() {
  const receipts = state.receipts.filter((receipt) => receipt.imageDataUrl);
  if (!receipts.length) {
    safeAlert("No saved receipt photos yet.");
    return;
  }
  receipts.forEach((receipt, index) => {
    const link = browserDocument.createElement("a");
    link.href = receipt.imageDataUrl;
    link.download = `${safeFileName(receipt.name || "receipt")}-${index + 1}.png`;
    browserDocument.body.appendChild(link);
    link.click();
    link.remove();
  });
}

function openReceiptImagePreview() {
  if (!parsedReceipt?.imageDataUrl) return;
  $("#imageViewerPhoto").src = parsedReceipt.imageDataUrl;
  $("#imageViewerDownload").href = parsedReceipt.imageDataUrl;
  $("#imageViewerDownload").download = `${safeFileName(parsedReceipt.name || "receipt")}.jpg`;
  $("#imageViewer").classList.remove("hidden");
}

function openSavedReceiptImagePreview(receiptId) {
  const receipt = state.receipts.find((item) => item.id === receiptId);
  if (!receipt?.imageDataUrl) return;
  $("#imageViewerPhoto").src = receipt.imageDataUrl;
  $("#imageViewerDownload").href = receipt.imageDataUrl;
  $("#imageViewerDownload").download = `${safeFileName(receipt.name || "receipt")}.jpg`;
  $("#imageViewer").classList.remove("hidden");
}

function closeReceiptImagePreview() {
  $("#imageViewer").classList.add("hidden");
}

function downloadPreviewImage(event) {
  const href = $("#imageViewerDownload").href;
  if (!href) return;
  if (/iphone|ipad/i.test(navigator.userAgent)) {
    return;
  }
  event.preventDefault();
  const link = browserDocument.createElement("a");
  link.href = href;
  link.download = $("#imageViewerDownload").download || "receipt.jpg";
  browserDocument.body.appendChild(link);
  link.click();
  link.remove();
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "receipt";
}

function toTitle(text) {
  return text
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bCfa\b/g, "CFA")
    .replace(/\bMd\b/g, "MD")
    .replace(/\bLg\b/g, "LG")
    .replace(/\bSm\b/g, "SM")
    .replace(/\bVat\b/g, "VAT")
    .replace(/\bUsd\b/g, "USD");
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function makeIcons() {
  if (isBrowser && window.lucide) window.lucide.createIcons();
}

function registerServiceWorker() {
  if (!isBrowser || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
