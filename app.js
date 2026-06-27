const storeKey = "trip-split-state-v2";
const rateKey = "trip-split-rates-v1";
const supportedCurrencies = ["USD", "THB", "VND"];
const defaultRates = { USD: 1, THB: 36.7, VND: 25400 };

let state = loadState();
let rates = loadRates();
let parsedReceipt = null;
let splitMode = "items";
let splitCount = 2;
let editingReceiptId = null;
let activeGroupId = new URLSearchParams(location.search).get("group") || localStorage.getItem("trip-split-group-id") || "";
let activePersonId = activeGroupId ? localStorage.getItem(`trip-split-person-${activeGroupId}`) || "" : "";
let activeGroup = null;
let syncTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  seedManualRows();
  registerServiceWorker();
  refreshRates();
  await initGroup();
  render();
  if (!activeGroupId || activePersonId) showScreen("home");
});

function loadState() {
  const saved = localStorage.getItem(storeKey);
  if (saved) return JSON.parse(saved);
  return {
    people: [
      { id: crypto.randomUUID(), name: "You" },
      { id: crypto.randomUUID(), name: "Friend" },
    ],
    receipts: [],
  };
}

function loadRates() {
  const saved = localStorage.getItem(rateKey);
  if (saved) return JSON.parse(saved);
  return { base: "USD", updatedAt: null, rates: defaultRates };
}

function saveState() {
  localStorage.setItem(storeKey, JSON.stringify(state));
}

function saveRates() {
  localStorage.setItem(rateKey, JSON.stringify(rates));
}

function bindEvents() {
  $$("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => showScreen(button.dataset.screen));
  });

  $("#resetApp").addEventListener("click", () => {
    if (!confirm("Reset people, receipts, and balances?")) return;
    localStorage.removeItem(storeKey);
    if (activeGroupId) {
      localStorage.removeItem("trip-split-group-id");
      localStorage.removeItem(`trip-split-person-${activeGroupId}`);
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

  $("#openManual").addEventListener("click", () => {
    setTodayIfBlank();
    showScreen("manual");
  });

  $("#personForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#personName");
    const name = input.value.trim();
    if (!name) return;
    addPerson(name);
    input.value = "";
  });

  $("#createGroup").addEventListener("click", createGroup);
  $("#copyInvite").addEventListener("click", copyInviteLink);
  $("#joinGroupForm").addEventListener("submit", joinGroup);

  $("#receiptImage").addEventListener("change", scanImage);
  $("#addManualItem").addEventListener("click", () => addManualItem());
  $("#manualToItemize").addEventListener("click", buildManualReceipt);
  $("#saveReceipt").addEventListener("click", saveReceipt);
  $("#decreaseSplit").addEventListener("click", () => updateSplitCount(splitCount - 1));
  $("#increaseSplit").addEventListener("click", () => updateSplitCount(splitCount + 1));

  ["manualTip", "manualTax", "manualFees", "manualDiscount"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderManualReview);
  });

  $$(".method").forEach((button) => {
    button.addEventListener("click", () => setSplitMode(button.dataset.splitMode));
  });
}

function showScreen(name) {
  $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === `screen-${name}`));
  window.scrollTo({ top: 0, behavior: "instant" });
  makeIcons();
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
    updateRateStatus("Live rates ready");
  } catch {
    updateRateStatus(rates.updatedAt ? "Using saved rates" : "Using starter rates");
  }
}

function updateRateStatus(text) {
  $("#rateStatus").textContent = text;
}

async function initGroup() {
  if (!activeGroupId) return;
  localStorage.setItem("trip-split-group-id", activeGroupId);
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
  const personName = $("#ownerName").value.trim() || "You";
  try {
    const result = await api("/api/groups", {
      method: "POST",
      body: { name, personName },
    });
    activeGroupId = result.group.id;
    activePersonId = result.person.id;
    localStorage.setItem("trip-split-group-id", activeGroupId);
    localStorage.setItem(`trip-split-person-${activeGroupId}`, activePersonId);
    history.replaceState(null, "", inviteUrl());
    applyGroup(result.group);
    startSync();
    render();
  } catch {
    alert("Could not create a shared group. Start the Trip Split server and try again.");
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
    localStorage.setItem("trip-split-group-id", activeGroupId);
    localStorage.setItem(`trip-split-person-${activeGroupId}`, activePersonId);
    applyGroup(result.group);
    startSync();
    render();
    showScreen("home");
  } catch {
    alert("Could not join this trip. Check that the invite server is running.");
  }
}

async function copyInviteLink() {
  if (!activeGroupId) return;
  $("#inviteLink").select();
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $("#groupStatus").textContent = "Invite copied";
  } catch {
    document.execCommand("copy");
    $("#groupStatus").textContent = "Invite copied";
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
      alert("Could not add this person to the shared group.");
      return;
    }
  }
  state.people.push({ id: crypto.randomUUID(), name });
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
  const url = new URL(location.href);
  url.searchParams.set("group", activeGroupId);
  return url.toString();
}

async function scanImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  prepareScanReceipt();
  showScreen("itemize");
  $("#scanStatus").textContent = "Reading receipt with receipt OCR...";

  try {
    const imageDataUrl = await fileToDataUrl(file);
    const text = await readReceiptText(file);
    const restaurantName = detectRestaurantName(text);
    parsedReceipt = parseReceipt(text, $("#receiptCurrency").value, {
      name: restaurantName || "Scanned receipt",
      restaurantName,
      date: new Date().toISOString().slice(0, 10),
      source: "scan",
      imageDataUrl,
    });
    if (!parsedReceipt.items.length) {
      $("#scanStatus").textContent = "No priced food items found. Try manual entry.";
      renderAssignment();
      return;
    }
    splitMode = "items";
    setSplitMode("items");
    $("#scanStatus").textContent = `${parsedReceipt.items.length} items found`;
    renderAssignment();
  } catch {
    $("#scanStatus").textContent = "Could not read that photo. Use manual entry.";
  } finally {
    event.target.value = "";
  }
}

async function readReceiptText(file) {
  try {
    return await readWithRemoteOcr(file);
  } catch {
    if (!window.Tesseract) throw new Error("No OCR available");
    $("#scanStatus").textContent = "Receipt OCR unavailable. Trying backup scanner...";
    const result = await Tesseract.recognize(file, "eng", {
      logger: (message) => {
        if (message.status === "recognizing text") {
          $("#scanStatus").textContent = `Backup scanner... ${Math.round(message.progress * 100)}%`;
        }
      },
    });
    return result.data.text;
  }
}

async function readWithRemoteOcr(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/ocr", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw new Error("Remote OCR failed");
  const data = await response.json();
  if (!data.text) throw new Error("No OCR text");
  return data.text;
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
    const entry = { id: crypto.randomUUID(), name: toTitle(itemName), amount: Math.abs(amount.value), assignedTo: [] };

    if (/(discount|promo|coupon|comp)/i.test(normalized)) {
      discount += Math.abs(amount.value);
      return;
    }

    if (/(tax|vat|gst|service|fee|charge|tip|gratuity|surcharge)/i.test(normalized)) {
      fees.push({ id: entry.id, name: entry.name, amount: Math.abs(amount.value) });
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
    .replace(/(\d)\s+([.,])\s+(\d)/g, "$1$2$3")
    .replace(/([$,฿₫])\s+(\d)/g, "$1$2")
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
  addManualItem("Burger", 1, 10);
  addManualItem("Sushi", 1, 15);
  renderManualReview();
}

function setTodayIfBlank() {
  if (!$("#manualDate").value) $("#manualDate").value = new Date().toISOString().slice(0, 10);
}

function addManualItem(name = "", qty = 1, price = "") {
  const id = crypto.randomUUID();
  const row = document.createElement("article");
  row.className = "manual-row";
  row.dataset.manualItem = id;
  row.innerHTML = `
    <div class="manual-name-line">
      <label>
        <span>Item name</span>
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
        <span>Unit price</span>
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
  const items = $$(".manual-row")
    .map((row) => {
      const name = row.querySelector('[data-field="name"]').value.trim();
      const qty = Number(row.querySelector('[data-field="qty"]').value || 0);
      const price = Number(row.querySelector('[data-field="price"]').value || 0);
      return { row, name, qty, price, total: qty * price };
    })
    .filter((item) => item.name && item.qty > 0 && item.price > 0);
  const tip = Number($("#manualTip").value || 0);
  const tax = Number($("#manualTax").value || 0);
  const fees = Number($("#manualFees").value || 0);
  const discount = Number($("#manualDiscount").value || 0);
  return { items, tip, tax, fees, discount };
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
  if (!draft.items.length) {
    alert("Add at least one priced item.");
    return;
  }
  const fees = [];
  if (draft.tip > 0) fees.push({ id: crypto.randomUUID(), name: "Tip", amount: draft.tip });
  if (draft.tax > 0) fees.push({ id: crypto.randomUUID(), name: "Tax", amount: draft.tax });
  if (draft.fees > 0) fees.push({ id: crypto.randomUUID(), name: "Fees", amount: draft.fees });
  parsedReceipt = {
    currency: $("#receiptCurrency").value,
    name: $("#manualName").value.trim() || "Dinner",
    date: $("#manualDate").value || new Date().toISOString().slice(0, 10),
    location: $("#manualLocation").value.trim(),
    description: $("#manualDescription").value.trim(),
    source: "manual",
    imageDataUrl: "",
    restaurantName: "",
    items: draft.items.map((item) => ({
      id: crypto.randomUUID(),
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
  const total = receiptTotal(parsedReceipt);
  $("#itemizeTitle").textContent = parsedReceipt.name || "Receipt";
  $("#parsedTotal").textContent = formatNative(total, parsedReceipt.currency);
  $("#itemCountLabel").textContent = `${parsedReceipt.items.length} item${parsedReceipt.items.length === 1 ? "" : "s"}`;
  $("#evenPeopleLabel").textContent = `${splitCount} people`;
  $("#splitCount").textContent = splitCount;
  $("#splitEachLabel").textContent = `${formatNative(total / splitCount, parsedReceipt.currency)} each`;
  $("#saveReceiptLabel").textContent = splitMode === "even" ? `Split ${formatNative(total, parsedReceipt.currency)}` : "Add to trip";

  $("#itemsList").innerHTML = parsedReceipt.items.length
    ? parsedReceipt.items
        .map(
          (item) => `
            <article class="item-row">
              <button class="delete-item" data-delete-item="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">
                <i data-lucide="trash-2"></i>
              </button>
              <div class="item-head">
                <label class="item-checkbox">
                  <input type="checkbox" data-item-pick="${item.id}" ${activePersonId && item.assignedTo?.includes(activePersonId) ? "checked" : ""}>
                  <span></span>
                </label>
                <div>
                  <div class="item-name">${escapeHtml(item.name)}</div>
                  <div class="subtext">${formatNative(item.amount, parsedReceipt.currency)}</div>
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

  $("#feesList").innerHTML = parsedReceipt.fees.length || parsedReceipt.discount
    ? [
        ...parsedReceipt.fees.map(
          (fee) => `<div class="fee-row"><span>${escapeHtml(fee.name)}</span><strong>${formatNative(fee.amount, parsedReceipt.currency)}</strong></div>`
        ),
        parsedReceipt.discount
          ? `<div class="fee-row"><span>Discount</span><strong>-${formatNative(parsedReceipt.discount, parsedReceipt.currency)}</strong></div>`
          : "",
      ].join("")
    : `<div class="fee-row"><span>No separate tip, tax, or fees</span><strong>${formatNative(0, parsedReceipt.currency)}</strong></div>`;

  $$("[data-item-pick]").forEach((box) => {
    box.addEventListener("change", () => {
      const id = box.dataset.itemPick;
      if (activePersonId) {
        const mine = $(`input[data-item="${id}"][data-person="${activePersonId}"]`);
        if (mine) mine.checked = box.checked;
      } else {
        $$(`input[data-item="${id}"]`).forEach((personBox) => {
          personBox.checked = box.checked;
        });
      }
    });
  });
  $$("[data-delete-item]").forEach((button) => {
    button.addEventListener("click", () => deleteParsedItem(button.dataset.deleteItem));
  });
  makeIcons();
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
  renderAssignment();
}

function updateSplitCount(next) {
  splitCount = Math.max(1, Math.min(30, next));
  renderAssignment();
}

function saveReceipt() {
  if (!parsedReceipt) return;
  const paidBy = $("#paidBy").value;
  if (!paidBy) {
    alert("Add at least one person and choose who paid.");
    return;
  }

  if (splitMode === "even") {
    parsedReceipt.items.forEach((item) => {
      item.assignedTo = state.people.map((person) => person.id);
    });
    parsedReceipt.splitEvenCount = splitCount;
  } else {
    parsedReceipt.items.forEach((item) => {
      item.assignedTo = $$(`input[data-item="${item.id}"]:checked`).map((box) => box.dataset.person);
    });
    if (parsedReceipt.items.some((item) => item.assignedTo.length === 0)) {
      alert("Every item needs at least one person selected, or choose Split evenly.");
      return;
    }
  }

  const shares = splitMode === "even" ? calculateEvenShares(parsedReceipt, splitCount) : calculateItemShares(parsedReceipt);
  const totalNative = sum(Object.values(shares.native));
  const receipt = {
    id: editingReceiptId || crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    currency: parsedReceipt.currency,
    name: parsedReceipt.name,
    date: parsedReceipt.date,
    location: parsedReceipt.location,
    description: parsedReceipt.description,
    restaurantName: parsedReceipt.restaurantName || "",
    imageDataUrl: parsedReceipt.imageDataUrl || "",
    paidBy,
    splitMode,
    splitCount,
    items: parsedReceipt.items,
    fees: parsedReceipt.fees,
    discount: parsedReceipt.discount || 0,
    shares,
    totalNative,
    totalUsd: toUsd(totalNative, parsedReceipt.currency),
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
  showScreen("totals");
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
  const activePeople = state.people.slice(0, peopleCount);
  const personIds = activePeople.length ? activePeople.map((person) => person.id) : state.people.map((person) => person.id);
  personIds.forEach((personId) => {
    native[personId] = total / personIds.length;
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
  renderPeopleOptions();
  renderPeople();
  renderTotals();
  renderHistory();
  renderSettlements();
  renderSummary();
  renderManualReview();
  makeIcons();
}

function renderGroupUi() {
  const signedIn = Boolean(activeGroupId && activePersonId && activeGroup);
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
}

function renderPeopleOptions() {
  $("#paidBy").innerHTML = state.people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("");
  if (activePersonId && state.people.some((person) => person.id === activePersonId)) $("#paidBy").value = activePersonId;
  splitCount = Math.max(1, Math.min(splitCount, state.people.length || 1));
}

function renderPeople() {
  $("#peopleList").innerHTML = state.people.length
    ? state.people
        .map(
          (person) => `
            <div class="person-row">
              <div>
                <div class="row-name">${escapeHtml(person.name)}</div>
                <div class="subtext">${personTotals(person.id).receiptCount} receipts shared</div>
              </div>
              <button aria-label="Remove ${escapeHtml(person.name)}" data-remove-person="${person.id}">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          `
        )
        .join("")
    : `<div class="empty">Add people before saving a receipt.</div>`;

  $$("[data-remove-person]").forEach((button) => {
    button.addEventListener("click", () => removePerson(button.dataset.removePerson));
  });
}

function removePerson(personId) {
  const used = state.receipts.some(
    (receipt) => receipt.paidBy === personId || Object.keys(receipt.shares.usd).some((id) => id === personId && receipt.shares.usd[id] > 0)
  );
  if (used) {
    alert("This person is already in a receipt. Reset the trip to remove them.");
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
                <div class="subtext">Share ${money.format(totals.owed)} · Paid ${money.format(totals.paid)}</div>
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
  $("#historyList").innerHTML = state.receipts.length
    ? state.receipts
        .map((receipt) => {
          const payer = findPerson(receipt.paidBy)?.name || "Unknown";
          const date = new Date(receipt.date || receipt.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return `
            <article class="history-row">
              <div class="row-head">
                <div>
                  <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                  <div class="subtext">${payer} paid · ${date} · ${receipt.splitMode === "even" ? "split evenly" : `${receipt.items.length} items`}</div>
                </div>
                <div class="money">${money.format(receipt.totalUsd)}</div>
              </div>
              <div class="subtext">Original ${formatNative(receipt.totalNative, receipt.currency)} · ${formatRate(receipt.currency, receipt.rateUsed)}</div>
              ${receipt.imageDataUrl ? `<a class="receipt-link" href="${receipt.imageDataUrl}" target="_blank" rel="noreferrer">View receipt image</a>` : ""}
              ${
                receipt.splitMode === "items"
                  ? `<button class="small-primary receipt-open" data-open-receipt="${receipt.id}"><i data-lucide="list-checks"></i><span>Claim items</span></button>`
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
}

function openReceiptForClaiming(receiptId) {
  const receipt = state.receipts.find((item) => item.id === receiptId);
  if (!receipt) return;
  editingReceiptId = receipt.id;
  parsedReceipt = JSON.parse(JSON.stringify(receipt));
  splitMode = "items";
  setSplitMode("items");
  renderAssignment();
  showScreen("itemize");
}

function renderSettlements() {
  const settlements = calculateSettlements();
  $("#settlementList").innerHTML = settlements.length
    ? settlements
        .map(
          (settlement) => `
            <div class="settle-row">
              <div>
                <div class="row-name">${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</div>
                <div class="subtext">Final net settlement</div>
              </div>
              <div class="money">${money.format(settlement.amount)}</div>
            </div>
          `
        )
        .join("")
    : `<div class="empty">Everyone is even once receipts are added and assigned.</div>`;
}

function renderSummary() {
  $("#tripTotal").textContent = money.format(sum(state.receipts.map((receipt) => receipt.totalUsd)));
  $("#receiptCount").textContent = `${state.receipts.length}`;
}

function personTotals(personId) {
  let owed = 0;
  let paid = 0;
  let receiptCount = 0;
  state.receipts.forEach((receipt) => {
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
    if (amount > 0) settlements.push({ from: debtor.person.name, to: creditor.person.name, amount });
    debtor.amount = roundCents(debtor.amount - amount);
    creditor.amount = roundCents(creditor.amount - amount);
    if (debtor.amount <= 0.005) debtorIndex += 1;
    if (creditor.amount <= 0.005) creditorIndex += 1;
  }
  return settlements;
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

function formatRate(currency, rate) {
  if (currency === "USD") return "1 USD";
  return `1 USD = ${Number(rate).toLocaleString("en-US", { maximumFractionDigits: currency === "VND" ? 0 : 2 })} ${currency}`;
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
  if (window.lucide) window.lucide.createIcons();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
