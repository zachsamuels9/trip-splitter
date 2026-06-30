const storeKey = "trip-split-state-v2";
const rateKey = "trip-split-rates-v1";
const groupsKey = "trip-split-known-groups-v1";
const deletedGroupsKey = "trip-split-deleted-groups-v1";
const accountEmailKey = "trip-split-account-email";
const iosInstallChoiceKey = "trip-split-ios-install-choice-v1";
const supportedCurrencies = ["USD", "THB", "VND"];
const defaultRates = { USD: 1, THB: 36.7, VND: 25400 };
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const browserDocument = isBrowser ? document : null;

let state = loadState();
let rates = loadRates();
let parsedReceipt = null;
let initiallyCoveredItemIds = new Set();
let manualAttachmentDataUrl = "";
let splitMode = "items";
let itemizeStage = "confirm";
let splitCount = 2;
let splitEvenPeople = [];
let editingReceiptId = null;
let activeGroupId = currentGroupId();
let activePersonId = activeGroupId ? readStorage(`trip-split-person-${activeGroupId}`) || "" : "";
let activeGroup = null;
let syncTimer = null;
let installReturnScreen = "home";
let inviteReturnScreen = "settings";
const settingsReturnScreens = new Set();
const navigationStack = [];
let currentScreenName = "";
let accountProfile = null;
let settlementArchiveOpen = false;
let expensesReturnHomeMode = false;
let knownGroupsCleanupInFlight = false;

const $ = (selector) => browserDocument?.querySelector(selector) || null;
const $$ = (selector) => Array.from(browserDocument?.querySelectorAll(selector) || []);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

if (isBrowser) {
  browserDocument.addEventListener("DOMContentLoaded", async () => {
    browserDocument.body.classList.toggle("standalone-webapp", isStandaloneWebApp());
    bindEvents();
    seedManualRows();
    registerServiceWorker();
    lockPortraitOrientation();
    state.receipts = normalizeReceipts(state.receipts);
    refreshRates();
    if (isAdminRoute()) {
      render();
      showScreen("admin");
      return;
    }
    if (isStartRoute() && !startInviteGroupId()) {
      activeGroupId = "";
      activePersonId = "";
      activeGroup = null;
      state = defaultState();
      render();
      showStartOnboarding();
      return;
    }
    await initGroup();
    render();
    if (isStartRoute() && !activeGroupId) {
      showStartOnboarding();
    } else if (!activeGroupId || activePersonId) {
      if (activeGroupId && activePersonId) setAppGroupUrl();
      showScreen(activeGroupId ? "home" : "account");
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
    people: [],
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
    const deleted = new Set(loadDeletedGroupIds());
    return JSON.parse(saved).filter((group) => group?.id && !deleted.has(group.id));
  } catch {
    return [];
  }
}

function saveKnownGroups(groups) {
  const deleted = new Set(loadDeletedGroupIds());
  writeStorage(groupsKey, JSON.stringify((groups || []).filter((group) => group?.id && !deleted.has(group.id))));
}

function loadDeletedGroupIds() {
  const saved = readStorage(deletedGroupsKey);
  if (!saved) return [];
  try {
    return JSON.parse(saved);
  } catch {
    return [];
  }
}

function forgetKnownGroup(groupId) {
  if (!groupId) return;
  writeStorage(deletedGroupsKey, JSON.stringify(Array.from(new Set([...loadDeletedGroupIds(), groupId]))));
  saveKnownGroups(loadKnownGroups().filter((group) => group.id !== groupId));
}

function rememberGroup(group, personId) {
  if (!group?.id) return;
  writeStorage(deletedGroupsKey, JSON.stringify(loadDeletedGroupIds().filter((id) => id !== group.id)));
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
    const urlGroupId = urlGroupIdParam();
    if (urlGroupId) return urlGroupId;
    return isStartRoute() ? "" : savedGroupId;
  } catch {
    return savedGroupId;
  }
}

function startInviteGroupId() {
  return isStartRoute() ? urlGroupIdParam() : "";
}

function urlGroupIdParam() {
  if (!isBrowser) return "";
  try {
    return new URLSearchParams(window.location.search).get("group") || "";
  } catch {
    return "";
  }
}

function isStartRoute() {
  if (!isBrowser) return false;
  return window.location.pathname.replace(/\/$/, "") === "/start";
}

function isAdminRoute() {
  if (!isBrowser) return false;
  return window.location.pathname.replace(/\/$/, "") === "/admin";
}

function appGroupPath(groupId = activeGroupId) {
  return groupId ? `/?group=${encodeURIComponent(groupId)}` : "/";
}

function setAppGroupUrl() {
  if (!isBrowser || isAdminRoute() || !activeGroupId) return;
  const nextPath = appGroupPath();
  if (`${window.location.pathname}${window.location.search}` !== nextPath) {
    window.history.replaceState(null, "", nextPath);
  }
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

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidPasscode(value) {
  return /^\d{4}$/.test(String(value || ""));
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
      if (button.classList.contains("back-button")) goBack(target);
      else showScreen(target);
    });
  });

  $("#resetApp").addEventListener("click", () => {
    resetTripExpenses();
  });
  $("#newGroup").addEventListener("click", () => {
    activeGroupId = "";
    activePersonId = "";
    activeGroup = null;
    state = defaultState();
    render();
    if (isBrowser) window.history.pushState(null, "", "/start");
    showStartOnboarding("groups");
  });
  $("#accountStart").addEventListener("click", () => {
    activeGroupId = "";
    activePersonId = "";
    activeGroup = null;
    state = defaultState();
    render();
    if (isBrowser) window.history.pushState(null, "", "/start");
    showStartOnboarding();
  });
  $("#accountSignIn").addEventListener("click", signInAccount);
  $("#startBack").addEventListener("click", () => goBack("groups"));
  $("#installNative").addEventListener("click", completeInstallStep);
  $("#installHome").addEventListener("click", skipInstallStep);
  $("#installBack").addEventListener("click", () => goBack(installReturnScreen));
  $("#showInstallHelp").addEventListener("click", () => {
    installReturnScreen = "settings";
    if (isInstallGuideSupported()) showInstallOrContinue(true);
    else safeAlert("Home Screen install guidance is only shown on supported iPhone browsers.");
  });
  $("#settingsInvite").addEventListener("click", () => {
    inviteReturnScreen = "settings";
    showScreen("invite");
  });
  $("#settingsCopyInvite").addEventListener("click", copyInviteLink);
  $("#settingsTextInvite").addEventListener("click", textInviteLink);
  $("#inviteHome").addEventListener("click", () => showScreen("home"));
  $("#downloadAllReceipts").addEventListener("click", downloadAllReceipts);
  $("#leaveTrip").addEventListener("click", leaveTrip);
  $("#signOut").addEventListener("click", signOutAccount);
  $("#saveAccount").addEventListener("click", saveAccountSettings);
  $("#loggedInBox").addEventListener("click", () => showScreen("account-settings"));
  $("#personalTotal").addEventListener("click", () => showScreen("expenses"));
  $("#expensesHome").addEventListener("click", () => showScreen("home"));
  $("#openReceipts").addEventListener("click", () => showScreen("totals"));
  $("#receiptSort").addEventListener("change", renderHistory);
  $("#closeTrip").addEventListener("click", closeTrip);
  $("#deleteTrip").addEventListener("click", deleteActiveTrip);
  $("#adminUnlock").addEventListener("click", loadAdminTrips);
  $("#adminRefresh").addEventListener("click", loadAdminTrips);
  $("#itemizeReceiptPreview").addEventListener("click", openReceiptImagePreview);
  $("#closeImageViewer").addEventListener("click", closeReceiptImagePreview);
  $("#imageViewerDownload").addEventListener("click", downloadPreviewImage);
  browserDocument.addEventListener("focusin", (event) => {
    if (event.target?.matches?.('input[type="number"]') && Number(event.target.value || 0) === 0) event.target.value = "";
  });

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

  $("#startCreateGroup").addEventListener("click", createStartGroup);
  $("#createGroup").addEventListener("click", createGroup);
  $("#copyInvite").addEventListener("click", copyInviteLink);
  $("#joinGroupForm").addEventListener("submit", joinGroup);

  $("#receiptImage").addEventListener("change", scanImage);
  $("#receiptUpload").addEventListener("change", scanImage);
  $("#scanDrop").addEventListener("click", openReceiptUpload);
  $("#scanDrop").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openReceiptUpload();
    }
  });
  $("#manualAttachmentButton").addEventListener("click", () => $("#manualAttachment")?.click());
  $("#manualAttachment").addEventListener("change", storeManualAttachment);
  $("#reviewAttachmentButton").addEventListener("click", () => $("#reviewAttachment")?.click());
  $("#reviewAttachment").addEventListener("change", storeReviewAttachment);
  $("#addManualItem").addEventListener("click", () => addManualItem());
  $("#claimRemaining").addEventListener("click", claimAllRemaining);
  $("#manualToItemize").addEventListener("click", buildManualReceipt);
  $("#addParsedItem").addEventListener("click", addParsedItem);
  $("#editManualItems").addEventListener("click", () => showScreen("manual"));
  $("#reviewSelections").addEventListener("click", reviewSelections);
  $("#acceptSelections").addEventListener("click", () => saveReceipt(false, true));
  $("#saveLaterReceipt").addEventListener("click", () => saveReceipt(true));
  $("#choosePickItems").addEventListener("click", () => beginSplitMethod("items"));
  $("#chooseSplitEvenly").addEventListener("click", () => beginSplitMethod("even"));
  $("#chooseAssignLater").addEventListener("click", () => saveReceipt(true));
  $("#confirmCurrency").addEventListener("click", confirmReviewCurrency);
  $("#currencyReviewSelect").addEventListener("change", () => {
    if (parsedReceipt) parsedReceipt.currency = $("#currencyReviewSelect").value;
  });
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
  $("#receiptCurrency").addEventListener("change", renderManualReview);

  ["reviewName", "reviewDate", "reviewNotes"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateParsedDetails);
  });
  $("#reviewCurrency").addEventListener("change", updateParsedCurrency);
  $("#paidBy").addEventListener("change", () => {
    if (parsedReceipt?.source === "manual") parsedReceipt.paidBy = $("#paidBy").value;
  });
  $("#reviewPaidBy").addEventListener("change", () => {
    if (parsedReceipt) {
      parsedReceipt.paidBy = $("#reviewPaidBy").value;
      renderReviewSummary();
      const payer = findPerson(parsedReceipt.paidBy);
      $("#parsedPaidBy").textContent = payer ? `${payer.name} paid for this tab` : "";
    }
  });

  ["reviewTip", "reviewTax", "reviewFees", "reviewDiscount"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateParsedAdjustments);
  });

  $$(".method").forEach((button) => {
    button.addEventListener("click", () => setSplitMode(button.dataset.splitMode));
  });
}

function showScreen(name, options = {}) {
  const activeName = currentScreenName || $(".screen.active")?.id?.replace("screen-", "") || "";
  if (!options.fromBack && !options.replace && activeName && activeName !== name) {
    navigationStack.push(activeName);
  }
  if (options.resetStack) navigationStack.length = 0;
  currentScreenName = name;
  browserDocument?.body.classList.remove("start-onboarding");
  updateBackTargets(name);
  $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === `screen-${name}`));
  if (name === "install") renderInstallScreen();
  if (name === "invite") renderInviteScreen();
  if (name === "expenses") {
    expensesReturnHomeMode = Boolean(options.afterExpense);
    renderExpenses();
  }
  trimPageToContent();
  makeIcons();
}

function trimPageToContent() {
  if (!isBrowser) return;
  window.scrollTo({ top: 0, behavior: "instant" });
  requestAnimationFrame(() => {
    const activeScreen = $(".screen.active");
    if (!activeScreen) return;
    const extra = Math.max(0, window.scrollY + window.innerHeight - browserDocument.documentElement.scrollHeight);
    if (extra > 0) window.scrollBy(0, -extra);
  });
}

function goBack(fallback = "home") {
  let previous = navigationStack.pop();
  while (previous && previous === currentScreenName) previous = navigationStack.pop();
  showScreen(previous || fallback || "home", { fromBack: true });
}

function renderInviteScreen() {
  const link = activeGroupId ? inviteUrl() : `${location.origin}/start`;
  $("#settingsInviteLink").value = link;
  $("#inviteQr").src = qrCodeUrl(link);
  $("#screen-invite .back-button").dataset.screen = inviteReturnScreen;
  $("#inviteHome").classList.toggle("hidden", inviteReturnScreen === "settings");
  $("#inviteCopyStatus").textContent = "";
}

function qrCodeUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(value)}`;
}

function updateBackTargets(name) {
  ["people", "totals"].forEach((screenName) => {
    const button = $(`#screen-${screenName} .back-button`);
    if (button) button.dataset.screen = settingsReturnScreens.has(screenName) ? "settings" : "home";
  });
  const groupsBack = $("#screen-groups .back-button");
  if (groupsBack) groupsBack.classList.toggle("hidden", !activeGroupId || !activePersonId);
  if (name === "home") settingsReturnScreens.clear();
}

function showStartOnboarding(returnTo = "") {
  browserDocument?.body.classList.remove("start-onboarding");
  removeStorage(iosInstallChoiceKey);
  $("#startBack").classList.toggle("hidden", returnTo !== "groups");
  showScreen("start");
}

function installGuideKind() {
  if (!isBrowser) return false;
  const ua = navigator.userAgent || "";
  const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIos) return "";
  if (/crios/i.test(ua)) return "chrome";
  if (/safari/i.test(ua) && !/fxios|edgios/i.test(ua)) return "safari";
  return "";
}

function isInstallGuideSupported() {
  return Boolean(installGuideKind());
}

function isStandaloneWebApp() {
  if (!isBrowser) return false;
  return Boolean(window.navigator.standalone) || window.matchMedia?.("(display-mode: standalone)")?.matches;
}

function shouldShowIosInstallStep() {
  return isInstallGuideSupported() && readStorage(iosInstallChoiceKey) !== "done";
}

function showInstallOrContinue(force = false) {
  if (force || shouldShowIosInstallStep()) showScreen("install");
  else showScreen(installReturnScreen || "home");
}

function lockPortraitOrientation() {
  if (!isBrowser || !screen.orientation?.lock) return;
  screen.orientation.lock("portrait").catch(() => {});
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
    state.receipts = normalizeReceipts(state.receipts);
    render();
  } catch {
    updateRateStatus(rates.updatedAt ? "Using saved rates" : "Using starter rates");
  }
}

function updateRateStatus(text) {
  const status = $("#rateStatus");
  if (status) status.textContent = text;
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
    setAppGroupUrl();
    startSync();
  } catch (error) {
    if (/Group not found|404/i.test(error.message || "")) {
      forgetKnownGroup(activeGroupId);
      removeStorage("trip-split-group-id");
      activeGroupId = "";
      activePersonId = "";
      activeGroup = null;
      state = defaultState();
      render();
      showScreen(loadKnownGroups().length ? "groups" : "account", { resetStack: true });
      return;
    }
    $("#groupStatus").textContent = "Group server offline";
  }
}

async function createStartGroup() {
  await createGroupFromValues($("#startGroupName").value, $("#startOwnerName").value, "invite", {
    email: $("#startOwnerEmail").value,
    passcode: $("#startOwnerPasscode").value,
  });
}

async function createGroup() {
  await createGroupFromValues($("#groupName").value, $("#ownerName").value, "install", {
    email: $("#ownerEmail").value,
    passcode: $("#ownerPasscode").value,
  });
}

async function createGroupFromValues(rawName, rawPersonName, nextScreen, account = {}) {
  const name = String(rawName || "").trim() || "Trip group";
  const personName = String(rawPersonName || "").trim();
  const email = cleanEmail(account.email);
  const passcode = String(account.passcode || "").trim();
  if (!personName) {
    safeAlert("Enter your name to create the trip.");
    const field = nextScreen === "invite" ? $("#startOwnerName") : $("#ownerName");
    field?.focus();
    return;
  }
  if (!email || !isValidPasscode(passcode)) {
    safeAlert("Enter your email and a 4-digit passcode.");
    return;
  }
  try {
    const result = await api("/api/groups", {
      method: "POST",
      body: { name, personName, personEmail: email, passcode },
    });
    activeGroupId = result.group.id;
    activePersonId = result.person.id;
    writeStorage("trip-split-group-id", activeGroupId);
    writeStorage(`trip-split-person-${activeGroupId}`, activePersonId);
    writeStorage(`trip-split-owner-${activeGroupId}`, activePersonId);
    writeStorage(accountEmailKey, email);
    accountProfile = result.account || { email, name: personName };
    setAppGroupUrl();
    applyGroup(result.group);
    rememberGroup(result.group, activePersonId);
    startSync();
    render();
    if (nextScreen === "invite") {
      inviteReturnScreen = "home";
      showScreen("invite");
    } else {
      installReturnScreen = "home";
      showInstallOrContinue();
    }
  } catch (error) {
    safeAlert(error.message || "Could not create a shared group. Try again in a moment.");
  }
}

async function joinGroup(event) {
  event.preventDefault();
  const name = $("#joinName").value.trim();
  const email = cleanEmail($("#joinEmail").value);
  const passcode = $("#joinPasscode").value.trim();
  if (!name || !activeGroupId) return;
  if (!email || !isValidPasscode(passcode)) {
    safeAlert("Enter your email and a 4-digit passcode.");
    return;
  }
  try {
    const result = await api(`/api/groups/${activeGroupId}/people`, {
      method: "POST",
      body: { name, email, passcode },
    });
    activePersonId = result.person.id;
    writeStorage("trip-split-group-id", activeGroupId);
    writeStorage(`trip-split-person-${activeGroupId}`, activePersonId);
    writeStorage(accountEmailKey, email);
    accountProfile = result.account || { email, name };
    applyGroup(result.group);
    rememberGroup(result.group, activePersonId);
    startSync();
    render();
    setAppGroupUrl();
    installReturnScreen = "home";
    showInstallOrContinue();
  } catch {
    safeAlert("Could not join this trip. Check that the invite server is running.");
  }
}

async function copyInviteLink() {
  if (!activeGroupId) return;
  const link = inviteUrl();
  const activeScreen = $(".screen.active")?.id;
  const visibleInput = activeScreen === "screen-invite" ? $("#settingsInviteLink") : $("#inviteLink");
  if (visibleInput) {
    visibleInput.value = link;
    visibleInput.select();
  }
  try {
    if (!isBrowser || !navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(link);
    const status = $("#groupStatus");
    if (status) status.textContent = "Invite copied";
    const inviteStatus = $("#inviteCopyStatus");
    if (inviteStatus) inviteStatus.textContent = "Invite link copied.";
  } catch {
    browserDocument?.execCommand("copy");
    const status = $("#groupStatus");
    if (status) status.textContent = "Invite copied";
    const inviteStatus = $("#inviteCopyStatus");
    if (inviteStatus) inviteStatus.textContent = "Invite link copied.";
  }
}

function textInviteLink() {
  if (!activeGroupId || !isBrowser) return;
  const body = encodeURIComponent(`Join my Split My Trip group: ${inviteUrl()}`);
  window.location.href = `sms:&body=${body}`;
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
  state.receipts = normalizeReceipts(group.receipts);
  saveState();
  rememberGroup(group, activePersonId);
}

function startSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncGroup, 4000);
}

function stopSync() {
  if (!syncTimer) return;
  clearInterval(syncTimer);
  syncTimer = null;
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

function readApiError(error) {
  const message = error?.message || "";
  if (!message) return "";
  try {
    const parsed = JSON.parse(message);
    return parsed.error || message;
  } catch {
    return message;
  }
}

async function signInAccount() {
  const email = cleanEmail($("#accountEmail").value);
  const passcode = $("#accountPasscode").value.trim();
  if (!email || !isValidPasscode(passcode)) {
    safeAlert("Enter your email and 4-digit passcode.");
    return;
  }
  try {
    const result = await api("/api/accounts", {
      method: "POST",
      body: { email, passcode },
    });
    accountProfile = result.account || null;
    writeStorage(accountEmailKey, email);
    saveKnownGroups(
      (result.trips || []).map((trip) => ({
        id: trip.id,
        name: trip.name,
        personId: trip.personId,
        updatedAt: trip.updatedAt || new Date().toISOString(),
      }))
    );
    const firstTrip = result.trips?.[0];
    if (!firstTrip) {
      activeGroupId = "";
      activePersonId = "";
      activeGroup = null;
      state = defaultState();
      render();
      showScreen("groups", { resetStack: true });
      return;
    }
    activeGroupId = firstTrip.id;
    activePersonId = firstTrip.personId;
    writeStorage("trip-split-group-id", activeGroupId);
    writeStorage(`trip-split-person-${activeGroupId}`, activePersonId);
    await initGroup();
    render();
    setAppGroupUrl();
    showScreen("home");
  } catch (error) {
    safeAlert(error.message || "Could not sign in.");
  }
}

async function saveAccountSettings() {
  if (!activePersonId) return;
  const email = cleanEmail($("#settingsEmail").value);
  const passcode = $("#settingsPasscode").value.trim();
  if (passcode && !isValidPasscode(passcode)) {
    safeAlert("Passcode must be exactly 4 digits.");
    return;
  }
  try {
    await api(`/api/accounts/${activePersonId}`, {
      method: "PATCH",
      body: {
        name: $("#settingsName").value.trim(),
        email,
        passcode,
      },
    });
    if (email) writeStorage(accountEmailKey, email);
    $("#settingsPasscode").value = "";
    $("#accountSettingsStatus").textContent = "Saved";
    await syncGroup();
  } catch (error) {
    safeAlert(error.message || "Could not save account.");
  }
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
  updateScanProgress("Reading receipt", "Uploading photo for scan...", true);
  setScanStep("captured");

  try {
    const originalImageDataUrl = await fileToDataUrl(file);
    setScanStep("prepared");
    const imageDataUrl = await optimizeImageDataUrl(originalImageDataUrl);
    setScanStep("compressed");
    const ocr = await readReceiptText(imageDataUrl);
    setScanStep("extracting", true);
    const text = ocr.text || "";
    const detectedCurrency = inferReceiptCurrency(ocr.receipt, text, $("#receiptCurrency").value).currency;
    $("#receiptCurrency").value = detectedCurrency;
    parsedReceipt = receiptFromOcrResult(ocr, imageDataUrl, detectedCurrency);
    parsedReceipt.ocrText = text;
    if (!parsedReceipt.items.length) {
      updateScanProgress("Needs review", "Document AI did not return priced items. Add them manually below.", false);
      showConfirmItems();
      return;
    }
    splitMode = "items";
    setSplitMode("items");
    updateScanProgress("Receipt read", `Ready to review in ${detectedCurrency} with ${ocr.provider}.`, false);
    $("#scanStatus").textContent = "";
    showConfirmItems();
  } catch (error) {
    const message = error.message || "Could not read that photo. Try a brighter image or use manual entry.";
    updateScanProgress("Scan failed", message, false, "failed");
    setScanFailed(message);
  } finally {
    event.target.value = "";
  }
}

function openReceiptUpload() {
  $("#receiptUpload")?.click();
}

async function readReceiptText(imageDataUrl) {
  updateScanProgress("Reading receipt", "Using server receipt scan...", true);
  setScanStep("uploaded");
  return readWithRemoteOcr(imageDataUrl);
}

function updateScanProgress(title, text, loading, stateName = "") {
  $("#scanModeLabel").textContent = loading ? "Scanning" : title;
  const progress = $("#scanProgress");
  progress.classList.remove("hidden");
  progress.classList.toggle("processing", Boolean(loading));
  progress.classList.toggle("failed", stateName === "failed");
  $("#scanProgressTitle").textContent = title;
  $("#scanProgressText").textContent = text;
  const scanStatus = $("#scanStatus");
  if (scanStatus) scanStatus.textContent = text;
}

function setScanStep(step, completeCurrent = false) {
  const order = ["captured", "prepared", "compressed", "uploaded", "extracting"];
  const activeIndex = order.indexOf(step);
  if (activeIndex < 0) return;
  $$("[data-scan-step]").forEach((row) => {
    const rowIndex = order.indexOf(row.dataset.scanStep);
    row.classList.toggle("done", rowIndex < activeIndex || (completeCurrent && rowIndex === activeIndex));
    row.classList.toggle("active", !completeCurrent && rowIndex === activeIndex);
    row.classList.remove("failed");
    row.style.order = `${rowIndex}`;
  });
}

function setScanFailed(message) {
  const active = $("[data-scan-step].active") || $('[data-scan-step="extracting"]');
  $$("[data-scan-step]").forEach((row) => {
    row.classList.remove("active");
    row.style.order = `${["captured", "prepared", "compressed", "uploaded", "extracting"].indexOf(row.dataset.scanStep)}`;
  });
  if (active) {
    active.classList.add("failed");
    const label = active.querySelector("strong");
    if (label) label.textContent = message;
  }
}

function resetScanStatus() {
  const scanStepLabels = {
    captured: "Receipt captured",
    prepared: "Preparing file",
    compressed: "Compressing image",
    uploaded: "Uploading",
    extracting: "Extracting items and prices",
  };
  $("#scanModeLabel").textContent = "Ready";
  $("#scanProgress").classList.add("hidden");
  $("#scanProgress").classList.remove("processing", "failed");
  $("#scanProgressTitle").textContent = "Reading receipt";
  $("#scanProgressText").textContent = "Preparing image...";
  $$("[data-scan-step]").forEach((row) => {
    row.classList.remove("done", "active", "failed");
    row.style.order = "";
    const label = row.querySelector("strong");
    if (label) label.textContent = scanStepLabels[row.dataset.scanStep] || label.textContent;
  });
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
  if (!data.receipt && !data.text) throw new Error("No receipt data");
  return { provider: data.provider || "receipt OCR", text: data.text || "", receipt: data.receipt || null, cached: Boolean(data.cached) };
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
  initiallyCoveredItemIds = new Set();
  renderAssignment();
}

function receiptFromOcrResult(ocr, imageDataUrl, fallbackCurrency) {
  const structured = ocr.receipt || {};
  const text = ocr.text || "";
  const currencyGuess = inferReceiptCurrency(structured, text, fallbackCurrency);
  const currency = currencyGuess.currency;
  const fallbackName = structured.merchant || detectRestaurantName(text) || "Scanned receipt";
  const fallback = parseReceipt(text, currency, {
    name: fallbackName,
    restaurantName: structured.merchant || "",
    date: structured.date || detectReceiptDate(text) || new Date().toISOString().slice(0, 10),
    source: "scan",
    imageDataUrl,
  });
  const items = (structured.lineItems || [])
    .filter((item) => Number(item.amount || item.unitPrice || 0) > 0)
    .map((item) => {
      const quantity = Math.max(1, Math.round(Number(item.quantity || 1)));
      const amount = roundCents(Number(item.amount || Number(item.unitPrice || 0) * quantity));
      return {
        id: createId(),
        name: toTitle(item.normalizedName || item.name || "Item"),
        originalName: item.name || "",
        category: item.category || "",
        amount,
        quantity,
        unitPrice: roundCents(Number(item.unitPrice || amount / quantity)),
        assignedTo: [],
        claims: {},
      };
    });
  const fees = [];
  if (Number(structured.tip || 0) > 0) fees.push({ id: createId(), name: "Tip", amount: roundCents(structured.tip) });
  if (Number(structured.tax || 0) > 0) fees.push({ id: createId(), name: "Tax", amount: roundCents(structured.tax) });
  if (Number(structured.fees || 0) > 0) fees.push({ id: createId(), name: "Fees", amount: roundCents(structured.fees) });
  const discount = roundCents(structured.discount || 0);
  const receipt = {
    ...fallback,
    currency,
    name: fallbackName,
    restaurantName: structured.merchant || fallback.restaurantName || "",
    date: structured.date || fallback.date,
    source: "scan",
    imageDataUrl,
    items: items.length ? items : fallback.items,
    fees: fees.length ? fees : fallback.fees,
    discount,
    currencyNeedsReview: currencyGuess.needsReview,
    ocrProvider: ocr.provider,
    ocrWarnings: structured.warnings || [],
  };
  const subtotal = sum(receipt.items.map((item) => item.amount));
  const knownTotal = Number(structured.total || 0);
  const calculated = subtotal + sum(receipt.fees.map((fee) => fee.amount)) - receipt.discount;
  if (knownTotal > calculated + 0.02 && receipt.items.length) {
    receipt.fees.push({ id: createId(), name: "Unitemized amount", amount: roundCents(knownTotal - calculated) });
  }
  return receipt;
}

function inferReceiptCurrency(receipt, text, fallback = "USD") {
  const context = [text, receipt?.merchant, ...(receipt?.lineItems || []).map((item) => `${item.name || ""} ${item.currency || ""}`)].join("\n");
  const contextCurrency = detectCurrency(context, "");
  const receiptCurrency = supportedCurrencies.includes(receipt?.currency) ? receipt.currency : "";
  if (contextCurrency === "USD" || receiptCurrency === "USD") return { currency: "USD", needsReview: false };
  if (hasExplicitCurrencyCue(context, "THB") || receiptCurrency === "THB") return { currency: "THB", needsReview: false };
  if (hasExplicitCurrencyCue(context, "VND") || receiptCurrency === "VND") return { currency: "VND", needsReview: false };
  if (contextCurrency && contextCurrency !== "USD") return { currency: contextCurrency, needsReview: true };
  if (receiptCurrency === "USD" && /\bUSD\b|United States|Arizona|California|New York|Texas|Florida/i.test(context)) return { currency: "USD", needsReview: false };
  const safeFallback = supportedCurrencies.includes(fallback) ? fallback : "THB";
  return { currency: safeFallback || "THB", needsReview: true };
}

function parseReceipt(text, currency, meta = {}) {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeReceiptLine(line))
    .filter(Boolean);

  const items = [];
  const fees = [];
  let discount = 0;
  let explicitTotal = 0;

  lines.forEach((line) => {
    const amount = extractTrailingAmount(line, currency);
    if (!amount || amount.value === 0) return;
    const rawLabel = line.slice(0, amount.index).replace(/[^\w\s&'()./-]/g, " ").replace(/\s+/g, " ").trim();
    const normalized = rawLabel.toLowerCase();

    if (/(discount|promo|coupon|comp)/i.test(normalized)) {
      discount += Math.abs(amount.value);
      return;
    }

    if (isTotalLine(normalized)) {
      explicitTotal = Math.max(explicitTotal, Math.abs(amount.value));
      return;
    }

    const adjustment = adjustmentKind(normalized);
    if (adjustment) {
      if (adjustment === "discount") discount += Math.abs(amount.value);
      else fees.push({ id: createId(), name: adjustmentLabel(adjustment), amount: Math.abs(amount.value) });
      return;
    }

    if (!isUsefulReceiptLabel(rawLabel)) return;

    const quantityInfo = parseQuantityFromLabel(rawLabel);
    const itemName = cleanItemName(quantityInfo.label);
    const totalAmount = Math.abs(amount.value);
    const quantity = quantityInfo.quantity;
    const entry = {
      id: createId(),
      name: toTitle(itemName),
      amount: totalAmount,
      quantity,
      unitPrice: roundCents(totalAmount / quantity),
      assignedTo: [],
      claims: {},
    };

    if (isLikelyFoodItem(itemName, amount.value, currency)) items.push(entry);
  });

  const calculatedTotal = sum(items.map((item) => item.amount)) + sum(fees.map((fee) => fee.amount)) - discount;
  if (explicitTotal > calculatedTotal + 0.02 && items.length) {
    fees.push({ id: createId(), name: "Unitemized amount", amount: roundCents(explicitTotal - calculatedTotal) });
  }

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

function isTotalLine(text) {
  return /\b(total|amount due|balance due|grand total|net total)\b/i.test(text) && !/\b(subtotal|sub total|tax|tip|discount)\b/i.test(text);
}

function parseQuantityFromLabel(label) {
  let text = String(label || "").trim();
  let quantity = 1;
  const leading = text.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|@)?\s+(.+)$/i);
  if (leading && Number(leading[1]) > 0 && Number(leading[1]) <= 99) {
    quantity = Number(leading[1]);
    text = leading[2].trim();
  }
  const multiplier = text.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(?:x|×|@)\s*$/i);
  if (multiplier && Number(multiplier[2]) > 0 && Number(multiplier[2]) <= 99) {
    quantity = Number(multiplier[2]);
    text = multiplier[1].trim();
  }
  return { quantity, label: text };
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
  if (hasExplicitCurrencyCue(sample, "USD")) return "USD";
  if (hasExplicitCurrencyCue(sample, "THB")) return "THB";
  if (hasExplicitCurrencyCue(sample, "VND")) return "VND";
  if (!/[$฿₫]/.test(sample) && /(?:\bBANGKOK\b|\bPHUKET\b|\bCHIANG\s*MAI\b|\bTHAILAND\b|[\u0E00-\u0E7F]|ถนน|กรุงเทพ)/i.test(sample)) return "THB";
  if (!/[$฿₫]/.test(sample) && /(?:\bVIETNAM\b|\bHANOI\b|\bSAIGON\b|\bHO CHI MINH\b|đường|quận|phường|[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ])/i.test(sample)) return "VND";
  return supportedCurrencies.includes(fallback) ? fallback : "";
}

function hasExplicitCurrencyCue(text, currency) {
  const sample = text || "";
  if (currency === "USD") return /\$|\bUSD\b/i.test(sample);
  if (currency === "THB") return /฿|\bTHB\b|\bBAHT\b|บาท/i.test(sample);
  if (currency === "VND") return /₫|\bVND\b|\bVNĐ\b|\bDONG\b/i.test(sample);
  return false;
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

async function storeManualAttachment(event) {
  const file = event.target.files?.[0];
  manualAttachmentDataUrl = file ? await fileToDataUrl(file) : "";
  $("#manualAttachmentStatus").textContent = file ? file.name || "Attachment added" : "Tap to add attachment";
  $("#manualAttachmentButton").classList.toggle("has-attachment", Boolean(file));
}

async function storeReviewAttachment(event) {
  if (!parsedReceipt) return;
  const file = event.target.files?.[0];
  if (!file) return;
  parsedReceipt.imageDataUrl = await fileToDataUrl(file);
  $("#reviewAttachmentStatus").textContent = file.name || "Attachment added";
  $("#reviewAttachmentButton").classList.add("has-attachment");
  renderAssignment();
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
    <div class="manual-item-fields">
      <label>
        <span>Qty *</span>
        <div class="confirm-qty manual-qty">
          <button type="button" data-manual-qty-step="${id}" data-delta="-1" aria-label="Decrease quantity"><i data-lucide="minus"></i></button>
          <input data-field="qty" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(Math.max(1, Number(qty || 1)))}" aria-label="Quantity" />
          <button type="button" data-manual-qty-step="${id}" data-delta="1" aria-label="Increase quantity"><i data-lucide="plus"></i></button>
        </div>
      </label>
      <label>
        <span>Unit price *</span>
        <div class="currency-input manual-price-input">
          <em class="manual-price-symbol">$</em>
          <input data-field="price" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(price)}" />
        </div>
      </label>
    </div>
    <div class="line-total"><span>Line total</span><strong>$0.00</strong></div>
  `;
  $("#manualItems").appendChild(row);
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", renderManualReview));
  row.querySelectorAll("[data-manual-qty-step]").forEach((button) => {
    button.addEventListener("click", () => stepManualQuantity(row, Number(button.dataset.delta || 0)));
  });
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
    const incomplete = touched && (!name || qty <= 0 || price <= 0);
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
    row.querySelector(".manual-price-symbol").textContent = currencySymbol($("#receiptCurrency").value);
    syncManualQuantityButtons(row);
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

function stepManualQuantity(row, delta) {
  const input = row.querySelector('[data-field="qty"]');
  if (!input) return;
  input.value = String(Math.max(1, Math.floor(Number(input.value || 1) + delta)));
  renderManualReview();
}

function syncManualQuantityButtons(row) {
  const input = row.querySelector('[data-field="qty"]');
  const current = Math.max(1, Math.floor(Number(input?.value || 1)));
  if (input && String(current) !== input.value) input.value = String(current);
  row.querySelector('[data-manual-qty-step][data-delta="-1"]')?.toggleAttribute("disabled", current <= 1);
}

function buildManualReceipt() {
  const draft = getManualDraft();
  if (!$("#receiptCurrency").value || !$("#paidBy").value || !$("#manualDate").value || !$("#manualName").value.trim()) {
    safeAlert("Add the required expense name, date, currency, and paid by fields.");
    return;
  }
  if (draft.incompleteRows.length) {
    safeAlert("Finish the item name, quantity, and unit price for any row you started, or leave it blank.");
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
    paidBy: $("#paidBy").value,
    description: $("#manualDescription").value.trim(),
    source: "manual",
    imageDataUrl: manualAttachmentDataUrl,
    restaurantName: "",
    items: draft.items.map((item) => ({
      id: createId(),
      name: item.name,
      amount: item.total,
      quantity: item.qty,
      unitPrice: item.price,
      assignedTo: [],
      claims: {},
    })),
    fees,
    discount: draft.discount,
  };
  initiallyCoveredItemIds = new Set();
  splitMode = "items";
  manualAttachmentDataUrl = "";
  $("#manualAttachment").value = "";
  $("#manualAttachmentStatus").textContent = "Tap to add attachment";
  $("#manualAttachmentButton").classList.remove("has-attachment");
  showConfirmItems();
}

function showConfirmItems() {
  itemizeStage = "confirm";
  splitMode = "items";
  setSplitMode("items");
  renderAssignment();
  showScreen("itemize");
}

function showSplitChoice() {
  if (!parsedReceipt) return;
  collectConfirmEdits();
  syncReceiptFromReview();
  renderSplitChoice();
  showScreen("split-choice");
}

function beginSplitMethod(mode) {
  itemizeStage = "assign";
  setSplitMode(mode);
  renderAssignment();
  showScreen("itemize");
}

function collectConfirmEdits() {
  if (!parsedReceipt) return;
  parsedReceipt.items.forEach((item) => {
    if ($(`[data-edit-item-name="${item.id}"]`)) updateParsedItem(item.id, { rerender: false });
  });
}

function syncReceiptFromReview() {
  updateParsedDetails();
  updateParsedCurrency();
  updateParsedAdjustments();
}

function renderSplitChoice() {
  if (!parsedReceipt) return;
  $("#splitChoiceName").textContent = parsedReceipt.name || "Receipt";
  $("#splitChoiceDate").textContent = formatLongDate(parsedReceipt.date) || "Today";
  $("#splitChoiceTotal").textContent = formatNative(receiptTotal(parsedReceipt), parsedReceipt.currency);
}

function renderAssignment() {
  if (!parsedReceipt) return;
  syncReviewFields();
  renderReviewSummary();
  $("#itemizeTitle").textContent = itemizeStage === "confirm" ? "Confirm items" : parsedReceipt.name || "Receipt";
  $("#itemizeKicker").textContent = itemizeStage === "confirm" ? (parsedReceipt.source === "manual" ? "Review expense" : "Smart scan by AI") : "Receipt total";
  $("#screen-itemize .back-button").dataset.screen = itemizeStage === "assign" ? "split-choice" : parsedReceipt.source === "manual" ? "manual" : "home";
  renderReceiptTotals();
  $("#pickItemsPanel h2").textContent = itemizeStage === "confirm" ? "Items" : "Select items";
  $("#itemCountLabel").textContent = `${parsedReceipt.items.length} item${parsedReceipt.items.length === 1 ? "" : "s"}`;
  $("#evenPeopleLabel").textContent = `${splitCount} ${splitCount === 1 ? "person" : "people"}`;
  $("#splitCount").textContent = splitCount;
  $("#increaseSplit").disabled = splitCount >= Math.max(1, state.people.length || 1);
  $("#decreaseSplit").disabled = splitCount <= 1;
  $("#saveLaterReceipt").classList.toggle("hidden", Boolean(editingReceiptId) || splitMode === "even");
  $("#itemizeReceiptPreview").classList.toggle("hidden", !parsedReceipt.imageDataUrl);
  if (parsedReceipt.imageDataUrl) {
    $("#itemizeReceiptImage").src = parsedReceipt.imageDataUrl;
  } else {
    $("#itemizeReceiptImage").removeAttribute("src");
  }
  const payer = findPerson(parsedReceipt.paidBy || $("#reviewPaidBy").value);
  $("#parsedPaidBy").textContent = payer ? `${payer.name} paid for this tab` : "";
  $("#currencyReviewPrompt").classList.toggle("hidden", !parsedReceipt.currencyNeedsReview || itemizeStage !== "confirm");
  $("#currencyReviewSelect").value = parsedReceipt.currency || "THB";
  $(".receipt-details").classList.toggle("hidden", itemizeStage !== "confirm");
  $("#receiptTipPanel").classList.toggle("hidden", itemizeStage !== "confirm" || parsedReceipt.source === "manual");
  $(".split-methods").classList.add("hidden");
  $("#claimRemaining").classList.toggle("hidden", itemizeStage !== "assign" || splitMode !== "items");
  updateClaimRemainingButton();
  $("#addParsedItem").classList.toggle("hidden", itemizeStage !== "confirm" || parsedReceipt.source === "manual");
  $("#editManualItems").classList.toggle("hidden", itemizeStage !== "confirm" || parsedReceipt.source !== "manual");
  renderEvenPeopleList();
  renderAmountSplitList();

  const coveredItems = editingReceiptId ? parsedReceipt.items.filter((item) => initiallyCoveredItemIds.has(item.id)) : [];
  const editableItems = editingReceiptId ? parsedReceipt.items.filter((item) => !initiallyCoveredItemIds.has(item.id)) : parsedReceipt.items;
  $("#coveredItemsPanel").classList.toggle("hidden", coveredItems.length === 0);
  $("#coveredItemsList").innerHTML = coveredItems.map((item) => itemRowMarkup(item, true)).join("");

  $("#itemsList").innerHTML = editableItems.length ? editableItems.map((item) => itemRowMarkup(item, false)).join("") : `<div class="empty">No priced food items found.</div>`;

  renderFeesList();

  $$("[data-claim-row]").forEach((row) => {
    row.addEventListener("click", () => toggleClaimRow(row.dataset.claimRow));
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
  $$("[data-edit-item-unit]").forEach((input) => {
    input.addEventListener("change", () => updateParsedItem(input.dataset.editItemUnit));
  });
  $$("[data-edit-item-qty]").forEach((input) => {
    input.addEventListener("change", () => updateParsedItem(input.dataset.editItemQty));
  });
  $$("[data-edit-qty-step]").forEach((button) => {
    button.addEventListener("click", () => stepConfirmQuantity(button.dataset.editQtyStep, Number(button.dataset.delta || 0)));
  });
  $$("[data-claim-adjust]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      adjustItemClaim(button.dataset.claimAdjust, button.dataset.person, Number(button.dataset.delta || 0));
    });
  });
  $$("[data-split-item]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      splitSingleItem(button.dataset.splitItem);
    });
  });
  $$("[data-share-person]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleItemSharePerson(button.dataset.shareItem, button.dataset.sharePerson);
    });
  });
  makeIcons();
  updateSelectionBar();
}

function itemRowMarkup(item, covered) {
  if (itemizeStage === "confirm") return confirmItemRowMarkup(item);
  return selectItemRowMarkup(item, covered);
}

function confirmItemRowMarkup(item) {
  if (parsedReceipt?.source === "manual") return confirmStaticItemRowMarkup(item);
  const quantity = itemQuantity(item);
  const currency = parsedReceipt.currency;
  const unitPrice = Number(item.unitPrice || (quantity ? Number(item.amount || 0) / quantity : item.amount) || 0);
  const total = Number(item.amount || unitPrice * quantity);
  const unitAmountClass = amountSizeClass(unitPrice, currency);
  const totalAmountClass = amountSizeClass(total, currency);
  const decreaseDisabled = quantity <= 1 ? "disabled" : "";
  return `
            <article class="confirm-item-card">
              <div class="confirm-item-head">
                <input class="claim-name-input" data-edit-item-name="${item.id}" type="text" value="${escapeHtml(item.name)}" aria-label="Item name" />
                <button class="delete-item" data-delete-item="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
              <div class="confirm-item-body">
                <label class="currency-input compact-price ${unitAmountClass}">
                  <em>${currencySymbol(currency)}</em>
                  <input data-edit-item-unit="${item.id}" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(unitPrice)}" />
                  <span class="unit-suffix">/ea</span>
                </label>
                <div class="confirm-qty">
                  <button type="button" data-edit-qty-step="${item.id}" data-delta="-1" aria-label="Decrease ${escapeHtml(item.name)}" ${decreaseDisabled}><i data-lucide="minus"></i></button>
                  <input data-edit-item-qty="${item.id}" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(quantity)}" aria-label="Quantity" />
                  <button type="button" data-edit-qty-step="${item.id}" data-delta="1" aria-label="Increase ${escapeHtml(item.name)}"><i data-lucide="plus"></i></button>
                </div>
                <strong class="claim-total ${totalAmountClass}">${formatNative(total, currency)}</strong>
              </div>
            </article>
          `;
}

function amountSizeClass(amount, currency) {
  const text = formatNative(Number(amount || 0), currency);
  if (text.length >= 12) return "amount-xs";
  if (text.length >= 9) return "amount-sm";
  return "";
}

function confirmStaticItemRowMarkup(item) {
  const quantity = itemQuantity(item);
  const currency = parsedReceipt.currency;
  const unitPrice = Number(item.unitPrice || (quantity ? Number(item.amount || 0) / quantity : item.amount) || 0);
  return `
            <article class="confirm-item-card readonly-confirm">
              <div class="confirm-item-head">
                <strong>${escapeHtml(item.name)}</strong>
                <span>${formatNative(unitPrice, currency)}${quantity > 1 ? ` each · Qty: ${quantity}` : ""}</span>
              </div>
              <div class="readonly-confirm-total">
                <strong class="claim-total">${formatNative(Number(item.amount || unitPrice * quantity), currency)}</strong>
              </div>
            </article>
          `;
}

function selectItemRowMarkup(item, covered) {
  const quantity = itemQuantity(item);
  const currency = parsedReceipt.currency;
  const activePerson = activePersonId || $("#reviewPaidBy").value || state.people[0]?.id || "";
  const activeName = findPerson(activePerson)?.name || "you";
  const activeSelected = Boolean(activePerson && item.assignedTo?.includes(activePerson));
  const activeClaim = itemClaimQuantity(item, activePerson);
  const unitPrice = Number(item.unitPrice || (quantity ? Number(item.amount || 0) / quantity : item.amount) || 0);
  const activeShare = itemShareForPerson(item, activePerson);
  const canSplitSingle = quantity === 1 && state.people.length > 1;
  const assignedPeople = (item.assignedTo || []).filter((personId) => state.people.some((person) => person.id === personId));
  const shareSummary = assignedPeople.length > 1 ? `Split ${assignedPeople.length} ways` : activeSelected ? `Covering ${formatNative(activeShare, currency)}` : "Tap to claim";
  const claimedByOthers = sum(
    Object.entries(item.claims || {})
      .filter(([personId]) => personId !== activePerson)
      .map(([, value]) => Number(value || 0))
  );
  const maxActiveClaim = Math.max(0, quantity - claimedByOthers);
  const removeDisabled = activeClaim <= 0 ? "disabled" : "";
  const addDisabled = activeClaim >= maxActiveClaim ? "disabled" : "";
  return `
            <article class="select-item-row ${activeSelected ? "selected" : ""}" data-claim-row="${item.id}">
              ${covered ? `<div class="covered-label"><span>Covered</span><small>Tap to edit</small></div>` : ""}
              <div class="select-item-copy">
                <strong>${escapeHtml(item.name)}</strong>
                <span>${formatNative(unitPrice, currency)}${quantity > 1 ? ` each · Qty: ${quantity}` : ""}</span>
                <em>${shareSummary}</em>
                ${
                  canSplitSingle
                    ? `<div class="share-chip-row" aria-label="Split ${escapeHtml(item.name)}">
                        ${state.people
                          .map(
                            (person) => `
                              <button type="button" class="${assignedPeople.includes(person.id) ? "active" : ""}" data-share-item="${item.id}" data-share-person="${person.id}">
                                ${escapeHtml(initials(person.name))}
                              </button>
                            `
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </div>
              <div class="claim-action-slot">
                ${
                  quantity > 1
                    ? `<div class="claim-stepper large ${activeSelected ? "" : "invisible"}" aria-label="${escapeHtml(activeName)} quantity">
                      <button type="button" data-claim-adjust="${item.id}" data-person="${activePerson}" data-delta="-1" aria-label="Remove one ${escapeHtml(item.name)}" ${removeDisabled}><i data-lucide="minus"></i></button>
                      <strong>${activeClaim || 0}</strong>
                      <button type="button" data-claim-adjust="${item.id}" data-person="${activePerson}" data-delta="1" aria-label="Add one ${escapeHtml(item.name)}" ${addDisabled}><i data-lucide="plus"></i></button>
                    </div>`
                    : `<strong class="claim-total">${formatNative(activeSelected ? activeShare : Number(item.amount || 0), currency)}</strong>`
                }
              </div>
            </article>
          `;
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
  $("#reviewTipSymbol").textContent = currencySymbol(parsedReceipt.currency || "USD");
  updateReviewAdjustmentSymbols();
  setReviewValue("reviewTax", adjustmentAmount("tax"));
  setReviewValue("reviewFees", adjustmentAmount("fees"));
  setReviewValue("reviewDiscount", parsedReceipt.discount || 0);
  $("#reviewAttachmentStatus").textContent = parsedReceipt.imageDataUrl ? "Attachment added" : "Tap to add attachment";
  $("#reviewAttachmentButton").classList.toggle("has-attachment", Boolean(parsedReceipt.imageDataUrl));
}

function renderReceiptTotals() {
  if (!parsedReceipt) return;
  const total = receiptTotal(parsedReceipt);
  const evenCount = splitMode === "even" ? Math.max(1, splitEvenPeople.length || splitCount) : splitCount;
  $("#parsedTotal").textContent = formatNative(total, parsedReceipt.currency);
  $("#splitEachLabel").textContent = `${formatNative(total / evenCount, parsedReceipt.currency)} each`;
  if (itemizeStage === "confirm") $("#saveReceiptLabel").textContent = "Looks good - continue";
  else $("#saveReceiptLabel").textContent = splitMode === "even" ? `Review ${formatNative(total, parsedReceipt.currency)}` : "Review selections";
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
    <div><span>Tip</span><strong>${formatNative(adjustmentAmount("tip"), parsedReceipt.currency)}</strong></div>
    <div><span>Tax / fees</span><strong>${formatNative(adjustmentAmount("tax") + adjustmentAmount("fees"), parsedReceipt.currency)}</strong></div>
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
  parsedReceipt.currencyNeedsReview = false;
  renderAssignment();
}

function updateReviewAdjustmentSymbols() {
  const symbol = currencySymbol(parsedReceipt?.currency || $("#reviewCurrency")?.value || "USD");
  $$(".review-adjustment-symbol").forEach((item) => {
    item.textContent = symbol;
  });
}

function confirmReviewCurrency() {
  if (!parsedReceipt) return;
  parsedReceipt.currency = $("#currencyReviewSelect").value;
  parsedReceipt.currencyNeedsReview = false;
  $("#reviewCurrency").value = parsedReceipt.currency;
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

function updateParsedItem(itemId, options = {}) {
  if (!parsedReceipt) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item) return;
  const name = $(`[data-edit-item-name="${itemId}"]`)?.value.trim();
  const quantity = Math.max(1, Number($(`[data-edit-item-qty="${itemId}"]`)?.value || item.quantity || 1));
  const unitInput = $(`[data-edit-item-unit="${itemId}"]`);
  const amountInput = $(`[data-edit-item-amount="${itemId}"]`);
  const unitPrice = unitInput ? Number(unitInput.value || 0) : 0;
  const amount = unitInput ? unitPrice * quantity : Number(amountInput?.value || 0);
  item.name = name || "Item";
  item.amount = Math.max(0, amount);
  item.quantity = quantity;
  item.unitPrice = quantity ? roundCents(item.amount / quantity) : item.amount;
  item.claims = clampClaims(item);
  if (options.rerender !== false) renderAssignment();
}

function stepConfirmQuantity(itemId, delta) {
  const input = $(`[data-edit-item-qty="${itemId}"]`);
  if (!input) return;
  input.value = String(Math.max(1, Number(input.value || 1) + delta));
  updateParsedItem(itemId);
}

function addParsedItem() {
  if (!parsedReceipt) return;
  parsedReceipt.items.push({
    id: createId(),
    name: "New item",
    amount: 0,
    quantity: 1,
    unitPrice: 0,
    assignedTo: activePersonId ? [activePersonId] : [],
    claims: activePersonId ? { [activePersonId]: 1 } : {},
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
  $("#itemizeActions").classList.toggle("inline-actions", mode !== "items");
  renderAssignment();
}

function updateSplitCount(next) {
  const maxPeople = Math.max(1, state.people.length || 1);
  splitCount = Math.max(1, Math.min(maxPeople, next));
  splitEvenPeople = state.people.slice(0, splitCount).map((person) => person.id);
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
      splitCount = Math.max(1, Math.min(state.people.length || 1, splitEvenPeople.length));
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
    const quantity = itemQuantity(item);
    if (quantity > 1) {
      item.claims = clampClaims(item);
      item.assignedTo = Object.keys(item.claims);
    } else {
      item.assignedTo = Array.from(new Set(item.assignedTo || []));
      item.claims = {};
    }
  });
}

function toggleClaimRow(itemId) {
  if (!parsedReceipt) return;
  const personId = activePersonId || $("#reviewPaidBy").value || state.people[0]?.id;
  if (!personId) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item) return;
  moveCoveredItemToMainList(itemId);
  if (itemQuantity(item) > 1) {
    const claims = { ...(item.claims || {}) };
    if (claims[personId]) delete claims[personId];
    else claims[personId] = 1;
    item.claims = clampClaims({ ...item, claims });
    item.assignedTo = Object.keys(item.claims);
  } else {
    const assigned = new Set(item.assignedTo || []);
    if (assigned.has(personId)) assigned.delete(personId);
    else assigned.add(personId);
    item.assignedTo = Array.from(assigned);
    item.claims = {};
  }
  renderAssignment();
}

function updateItemPersonSelection(box) {
  if (!parsedReceipt) return;
  const item = parsedReceipt.items.find((entry) => entry.id === box.dataset.item);
  if (!item) return;
  if (itemQuantity(item) > 1) {
    const claims = { ...(item.claims || {}) };
    if (box.checked) {
      if (!claims[box.dataset.person]) claims[box.dataset.person] = 1;
    } else {
      delete claims[box.dataset.person];
    }
    item.claims = clampClaims({ ...item, claims });
    item.assignedTo = Object.keys(item.claims);
    renderAssignment();
    return;
  }
  updateSelectionBar();
}

function adjustItemClaim(itemId, personId, delta) {
  if (!parsedReceipt) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item) return;
  moveCoveredItemToMainList(itemId);
  const claims = { ...(item.claims || {}) };
  const requested = Math.max(0, Number(claims[personId] || 0) + delta);
  if (requested > 0) claims[personId] = requested;
  else delete claims[personId];
  item.claims = clampClaims({ ...item, claims });
  item.assignedTo = Object.keys(item.claims);
  renderAssignment();
}

function splitSingleItem(itemId) {
  if (!parsedReceipt) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item || itemQuantity(item) !== 1) return;
  moveCoveredItemToMainList(itemId);
  const activePerson = activePersonId || $("#reviewPaidBy").value || state.people[0]?.id;
  if (!activePerson) return;
  const maxPeople = Math.max(2, state.people.length);
  const requested = Number(safePrompt(`Split this item how many ways?`, "2") || 0);
  const splitCount = Math.min(maxPeople, Math.max(2, Math.floor(requested || 2)));
  const otherPeople = state.people.map((person) => person.id).filter((id) => id && id !== activePerson);
  item.assignedTo = [activePerson, ...otherPeople.slice(0, splitCount - 1)];
  item.claims = {};
  renderAssignment();
}

function toggleItemSharePerson(itemId, personId) {
  if (!parsedReceipt || !personId) return;
  const item = parsedReceipt.items.find((entry) => entry.id === itemId);
  if (!item || itemQuantity(item) !== 1) return;
  moveCoveredItemToMainList(itemId);
  const assigned = new Set(item.assignedTo || []);
  if (assigned.has(personId)) assigned.delete(personId);
  else assigned.add(personId);
  item.assignedTo = Array.from(assigned);
  item.claims = {};
  renderAssignment();
}

function moveCoveredItemToMainList(itemId) {
  if (!initiallyCoveredItemIds.has(itemId)) return;
  initiallyCoveredItemIds.delete(itemId);
}

function safePrompt(message, fallback = "") {
  if (!isBrowser || typeof window.prompt !== "function") return fallback;
  return window.prompt(message, fallback);
}

function claimAllRemaining() {
  if (!parsedReceipt) return;
  const personId = activePersonId || $("#reviewPaidBy").value;
  if (!personId) return;
  if (hasClaimedAllRemaining(personId)) {
    parsedReceipt.items.forEach((item) => removePersonFromItem(item, personId));
    renderAssignment();
    return;
  }
  parsedReceipt.items.forEach((item) => {
    if (!itemHasUnassignedQuantity(item)) return;
    const quantity = itemQuantity(item);
    if (quantity > 1) {
      const claimed = sum(Object.values(item.claims || {}));
      const remaining = Math.max(0, quantity - claimed);
      if (remaining > 0) {
        item.claims = { ...(item.claims || {}), [personId]: Number(item.claims?.[personId] || 0) + remaining };
        item.assignedTo = Array.from(new Set([...(item.assignedTo || []), personId]));
      }
    } else {
      item.assignedTo = Array.from(new Set([...(item.assignedTo || []), personId]));
    }
  });
  renderAssignment();
}

function hasClaimedAllRemaining(personId) {
  return parsedReceipt?.items?.some((item) => (item.assignedTo || []).includes(personId)) && parsedReceipt.items.every((item) => !itemHasUnassignedQuantity(item) || (item.assignedTo || []).includes(personId));
}

function removePersonFromItem(item, personId) {
  item.assignedTo = (item.assignedTo || []).filter((id) => id !== personId);
  if (item.claims) delete item.claims[personId];
}

function updateClaimRemainingButton() {
  const button = $("#claimRemaining");
  if (!button || !parsedReceipt) return;
  const personId = activePersonId || $("#reviewPaidBy").value;
  const selectedAll = personId && hasClaimedAllRemaining(personId);
  button.querySelector("span").textContent = selectedAll ? "Deselect all" : "Select all remaining";
  button.querySelector("i")?.setAttribute("data-lucide", selectedAll ? "list-x" : "list-plus");
}

function selectedItemsForActivePerson() {
  if (!parsedReceipt) return [];
  const personId = activePersonId || $("#reviewPaidBy").value;
  return parsedReceipt.items.filter((item) => (item.assignedTo || []).includes(personId));
}

function selectedNativeTotal() {
  if (!parsedReceipt) return 0;
  if (splitMode === "even") {
    const manualAmount = Number($(`[data-amount-person="${activePersonId || $("#reviewPaidBy").value}"]`)?.value || 0);
    if (assignedAmountTotal() > 0) return manualAmount;
    return receiptTotal(parsedReceipt) / Math.max(1, splitEvenPeople.length || splitCount);
  }
  if (splitMode === "amounts") return Number($(`[data-amount-person="${activePersonId || $("#reviewPaidBy").value}"]`)?.value || 0);
  return sum(selectedItemsForActivePerson().map(itemShareForActivePerson)) + selectedAdjustmentShare();
}

function selectedAdjustmentShare() {
  if (!parsedReceipt) return 0;
  const selectedSubtotal = sum(selectedItemsForActivePerson().map(itemShareForActivePerson));
  const subtotal = sum(parsedReceipt.items.map((item) => item.amount));
  if (!selectedSubtotal || !subtotal) return 0;
  return (sum(parsedReceipt.fees.map((fee) => fee.amount)) - (parsedReceipt.discount || 0)) * (selectedSubtotal / subtotal);
}

function itemShareForActivePerson(item) {
  return itemShareForPerson(item, activePersonId || $("#reviewPaidBy").value);
}

function itemShareForPerson(item, personId) {
  if (!personId || !(item.assignedTo || []).includes(personId)) return 0;
  const claims = item.claims || {};
  const claimedTotal = sum(Object.values(claims));
  if (itemQuantity(item) > 1 && claimedTotal > 0) return Number(item.amount || 0) * (Number(claims[personId] || 0) / itemQuantity(item));
  return Number(item.amount || 0) / Math.max(1, (item.assignedTo || []).length);
}

function itemQuantity(item) {
  return Math.max(1, Math.floor(Number(item.quantity || 1)));
}

function itemClaimQuantity(item, personId) {
  const claims = item.claims || {};
  return Number(claims[personId] || 0);
}

function clampClaims(item) {
  const quantity = itemQuantity(item);
  let remaining = quantity;
  const claims = {};
  Object.entries(item.claims || {}).forEach(([personId, value]) => {
    const claim = Math.min(remaining, Math.max(0, Math.floor(Number(value || 0))));
    if (claim > 0) {
      claims[personId] = claim;
      remaining -= claim;
    }
  });
  return claims;
}

function distributeQuantity(quantity, people) {
  const claims = {};
  let remaining = quantity;
  people.forEach((personId, index) => {
    const slots = people.length - index;
    const claim = Math.max(0, Math.floor(remaining / slots));
    if (claim > 0) claims[personId] = claim;
    remaining -= claim;
  });
  if (remaining > 0 && people[0]) claims[people[0]] = (claims[people[0]] || 0) + remaining;
  return claims;
}

function updateSelectionBar() {
  if (!parsedReceipt) return;
  if (itemizeStage === "confirm") {
    $("#selectionTotal").classList.add("hidden");
    $("#saveLaterReceipt").classList.add("hidden");
    $("#reviewSelections").classList.remove("hidden");
    $("#itemizeActions").classList.remove("inline-actions");
    return;
  }
  collectAssignmentChoices();
  const hasSelection = splitMode === "even" || splitMode === "amounts" || selectedItemsForActivePerson().length > 0;
  $("#selectionTotal").classList.toggle("hidden", !hasSelection);
  $("#reviewSelections").classList.toggle("hidden", !hasSelection);
  $("#saveLaterReceipt").classList.toggle("hidden", hasSelection || Boolean(editingReceiptId) || splitMode !== "items");
  $("#selectionTotal").textContent = `Selected ${formatNative(selectedNativeTotal(), parsedReceipt.currency)}`;
}

function reviewSelections() {
  if (!parsedReceipt) return;
  if (itemizeStage === "confirm") {
    if (parsedReceipt.currencyNeedsReview) {
      safeAlert("Confirm the receipt currency before continuing.");
      return;
    }
    showSplitChoice();
    return;
  }
  collectAssignmentChoices();
  const selector = findPerson(activePersonId || $("#reviewPaidBy").value)?.name || "Your";
  $("#selectionReviewTitle").textContent = `${possessive(selector)} selected items`;
  if (splitMode === "even") {
    const amountEntries = $$("[data-amount-person]").map((input) => ({ personId: input.dataset.amountPerson, amount: Number(input.value || 0) })).filter((entry) => entry.amount > 0);
    if (amountEntries.length) {
      parsedReceipt.amountSplits = Object.fromEntries(amountEntries.map((entry) => [entry.personId, entry.amount]));
      const nativeTotal = parsedReceipt.amountSplits[activePersonId] || 0;
      $("#selectionReviewTotal").textContent = formatNative(nativeTotal, parsedReceipt.currency);
      $("#selectionReviewReceipt").textContent = `${parsedReceipt.name || "Receipt"} · specific amounts`;
      $("#selectionReviewCount").textContent = `${amountEntries.length} people`;
      $("#selectionReviewList").innerHTML = amountEntries
        .map((entry) => `<div class="fee-row"><span>${escapeHtml(findPerson(entry.personId)?.name || "Guest")}</span><strong>${formatNative(entry.amount, parsedReceipt.currency)}</strong></div>`)
        .join("") + convertedLine(nativeTotal, parsedReceipt.currency);
      showScreen("selection-review");
      return;
    }
    const people = splitEvenPeople.length ? splitEvenPeople : state.people.map((person) => person.id);
    const nativeTotal = receiptTotal(parsedReceipt) / Math.max(1, people.length);
    $("#selectionReviewTotal").textContent = formatNative(nativeTotal, parsedReceipt.currency);
    $("#selectionReviewReceipt").textContent = parsedReceipt.name || "Receipt";
    $("#selectionReviewCount").textContent = `${people.length} people`;
    $("#selectionReviewList").innerHTML = `<div class="fee-row"><span>Your even share (1/${Math.max(1, people.length)})</span><strong>${formatNative(nativeTotal, parsedReceipt.currency)}</strong></div>${convertedLine(nativeTotal, parsedReceipt.currency)}`;
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
  $("#selectionReviewReceipt").textContent = parsedReceipt.name || "Expense";
  $("#selectionReviewCount").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
  const nativeTotal = selectedNativeTotal();
  $("#selectionReviewList").innerHTML = [
    ...items.map((item) => `<div class="fee-row"><span>${escapeHtml(item.name)}</span><strong>${formatNative(itemShareForActivePerson(item), parsedReceipt.currency)}</strong></div>`),
    adjustment ? `<div class="fee-row adjustment-row"><span>Tip, tax, fees</span><strong>${formatNative(adjustment, parsedReceipt.currency)}</strong></div>` : "",
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
  if (isTripClosed() && !editingReceiptId) {
    safeAlert("This trip is closed. New expenses are locked.");
    showScreen("home");
    return;
  }
  const paidBy = $("#reviewPaidBy").value;
  if (!paidBy) {
    safeAlert("Add at least one person and choose who paid.");
    return;
  }
  parsedReceipt.paidBy = paidBy;

  if (assignLater) {
    parsedReceipt.items.forEach((item) => {
      item.assignedTo = [];
      item.claims = {};
    });
    parsedReceipt.splitEvenCount = null;
  } else if (splitMode === "even") {
    const amountEntries = $$("[data-amount-person]").map((input) => [input.dataset.amountPerson, Number(input.value || 0)]).filter(([, amount]) => amount > 0);
    if (amountEntries.length) {
      parsedReceipt.amountSplits = Object.fromEntries(amountEntries);
      parsedReceipt.items = amountEntries.map(([personId, amount]) => ({
        id: createId(),
        name: `Share - ${findPerson(personId)?.name || "Guest"}`,
        amount,
        quantity: 1,
        unitPrice: amount,
        assignedTo: [personId],
        claims: {},
      }));
      parsedReceipt.fees = [];
      parsedReceipt.discount = 0;
      parsedReceipt.splitEvenCount = null;
    } else {
      const people = splitEvenPeople.length ? splitEvenPeople : state.people.map((person) => person.id);
      parsedReceipt.items.forEach((item) => {
        item.assignedTo = people;
        const quantity = itemQuantity(item);
        item.claims = quantity > 1 ? distributeQuantity(quantity, people) : {};
      });
      parsedReceipt.splitEvenCount = people.length;
    }
  } else if (splitMode === "amounts") {
    parsedReceipt.amountSplits = Object.fromEntries($$("[data-amount-person]").map((input) => [input.dataset.amountPerson, Number(input.value || 0)]));
    parsedReceipt.items = Object.entries(parsedReceipt.amountSplits)
      .filter(([, amount]) => amount > 0)
      .map(([personId, amount]) => ({
        id: createId(),
        name: `Share - ${findPerson(personId)?.name || "Guest"}`,
        amount,
        quantity: 1,
        unitPrice: amount,
        assignedTo: [personId],
        claims: {},
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

  const usingSpecificAmounts = !assignLater && parsedReceipt.amountSplits && Object.values(parsedReceipt.amountSplits).some((amount) => Number(amount) > 0);
  const savedSplitMode = assignLater ? "items" : usingSpecificAmounts ? "amounts" : splitMode;
  const shares = assignLater
    ? withUsd(emptyPersonMap(), parsedReceipt.currency)
    : usingSpecificAmounts
      ? calculateAmountShares(parsedReceipt)
      : splitMode === "even"
        ? calculateEvenShares(parsedReceipt, splitEvenPeople.length || splitCount)
        : calculateItemShares(parsedReceipt);
  const receipt = {
    id: editingReceiptId || createId(),
    createdAt: state.receipts.find((existing) => existing.id === editingReceiptId)?.createdAt || new Date().toISOString(),
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
    assignmentStatus: assignLater || parsedReceipt.items.some(itemHasUnassignedQuantity) ? "pending" : "complete",
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
  initiallyCoveredItemIds = new Set();
  saveState();
  saveGroupReceipt(receipt);
  render();
  if (directToExpenses && !assignLater) showScreen("expenses", { afterExpense: true, replace: true });
  else showConfirmation(receipt, assignLater);
}

function calculateItemShares(receipt) {
  const native = emptyPersonMap();
  receipt.items.forEach((item) => {
    item.assignedTo.forEach((personId) => {
      native[personId] += itemShareForPerson(item, personId);
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

function normalizeReceipts(receipts = []) {
  return receipts.map((receipt) => {
    const currency = receipt.currency || "USD";
    const items = (receipt.items || []).map((item) => normalizeItem(item));
    const normalizedReceipt = { ...receipt, items, fees: receipt.fees || [], discount: receipt.discount || 0 };
    const totalNative = Number(receipt.totalNative ?? receipt.totalUsd ?? receiptTotal(normalizedReceipt));
    const sharesNative = receipt.shares?.native || receipt.shares?.usd || {};
    return {
      ...normalizedReceipt,
      totalNative,
      totalUsd: toUsd(totalNative, currency),
      rateUsed: currency === "USD" ? 1 : rates.rates[currency] || receipt.rateUsed || 1,
      shares: withUsd(sharesNative, currency),
    };
  });
}

function normalizeItem(item) {
  const quantity = itemQuantity(item);
  return {
    ...item,
    quantity,
    unitPrice: Number(item.unitPrice || (quantity ? Number(item.amount || 0) / quantity : item.amount || 0)),
    assignedTo: item.assignedTo || [],
    claims: item.claims || {},
  };
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
  renderInstallEntryPoints();
  makeIcons();
}

function renderInstallEntryPoints() {
  $("#showInstallHelp")?.classList.toggle("hidden", !isInstallGuideSupported());
}

function renderGroupUi() {
  const signedIn = Boolean(activeGroupId && activePersonId && activeGroup);
  $("#resetApp").classList.add("hidden");
  $("#closeTrip").classList.add("hidden");
  $("#homeGroupSetup").classList.toggle("hidden", signedIn);
  $("#homeTripTitle").textContent = activeGroup?.name || "Group expenses";
  const closed = isTripClosed();
  $(".action-panel")?.classList.toggle("hidden", closed);
  $(".quick-nav")?.classList.toggle("trip-closed", closed);
  $('.quick-nav button[data-screen="expenses"]')?.classList.toggle("hidden", closed);
  $("#closedBanner")?.classList.toggle("hidden", !closed);
  if (closed) {
    const activeSettlements = calculateSettlements().filter((settlement) => !settledSettlementIds().includes(settlement.id));
    const complete = state.receipts.every((receipt) => !isPendingReceipt(receipt)) && activeSettlements.length === 0;
    $("#closedBanner .section-title span").textContent = complete ? "Complete" : "Settle up";
    $("#closedBanner .subtext").textContent = complete
      ? "Everything is split and settled."
      : "New expenses are locked. Finish pending splits and use Settle to close balances.";
  }
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
  $("#settingsName").value = person?.name || "";
  $("#settingsEmail").value = person?.email || readStorage(accountEmailKey) || "";
  $("#accountSettingsStatus").textContent = person?.email || readStorage(accountEmailKey) ? "Signed in" : "Add email";
  $("#resetApp").classList.toggle("hidden", !isTripOwner());
  $("#leaveTrip").classList.toggle("hidden", isTripOwner());
  $("#closeTrip").classList.toggle("hidden", !isTripOwner());
  $("#deleteTrip").classList.toggle("hidden", !isTripOwner());
  $("#closeTripLabel").textContent = closed ? "Reopen trip" : "Close trip and settle";
}

async function resetTripExpenses() {
  if (!activeGroupId || !isTripOwner()) return;
  if (!safeConfirm("Reset this trip and clear all expenses for everyone?")) return;
  if (!safeConfirm("Keep people, but delete all receipts, balances, and settlements?")) return;
  try {
    const result = await api(`/api/groups/${activeGroupId}/reset`, { method: "POST" });
    applyGroup(result.group);
  } catch (error) {
    safeAlert(error.message || "Could not reset this trip.");
  }
  render();
  showScreen("home");
}

function isTripClosed() {
  return activeGroup?.status === "closed" || Boolean(activeGroup?.closedAt) || readStorage(`trip-split-closed-${activeGroupId}`) === "true";
}

async function closeTrip() {
  if (!activeGroupId || !isTripOwner()) return;
  const closed = isTripClosed();
  if (!safeConfirm(closed ? "Reopen this trip for new expenses?" : "Close this trip for settlement?")) return;
  try {
    const result = await api(`/api/groups/${activeGroupId}/${closed ? "reopen" : "close"}`, { method: "POST" });
    applyGroup(result.group);
  } catch {
    if (closed) removeStorage(`trip-split-closed-${activeGroupId}`);
    else writeStorage(`trip-split-closed-${activeGroupId}`, "true");
  }
  render();
  showScreen(closed ? "home" : "settle");
}

async function deleteActiveTrip() {
  if (!activeGroupId || !isTripOwner()) return;
  if (!safeConfirm("Delete this trip for everyone? You can recover it later from admin.")) return;
  if (!safeConfirm("Really delete this trip and hide it from everyone?")) return;
  const deletedGroupId = activeGroupId;
  stopSync();
  try {
    await api(`/api/admin/trips/${deletedGroupId}`, { method: "DELETE", body: { password: "1234" } });
  } catch (error) {
    startSync();
    safeAlert(error.message || "Could not delete this trip.");
    return;
  }
  removeStorage(`trip-split-person-${deletedGroupId}`);
  removeStorage(`trip-split-owner-${deletedGroupId}`);
  removeStorage("trip-split-group-id");
  forgetKnownGroup(deletedGroupId);
  const remainingGroups = loadKnownGroups();
  activeGroupId = "";
  activePersonId = "";
  activeGroup = null;
  state = defaultState();
  render();
  if (remainingGroups.length) {
    showScreen("groups", { resetStack: true });
  } else {
    if (isBrowser) window.history.pushState(null, "", "/start");
    showStartOnboarding();
  }
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
  stopSync();
  render();
  showScreen("groups");
}

function signOutAccount() {
  if (!safeConfirm("Sign out on this device?")) return;
  if (activeGroupId) removeStorage(`trip-split-person-${activeGroupId}`);
  removeStorage("trip-split-group-id");
  removeStorage(accountEmailKey);
  activePersonId = "";
  activeGroupId = "";
  activeGroup = null;
  state = defaultState();
  stopSync();
  render();
  if (isBrowser) window.history.replaceState(null, "", "/");
  showScreen("account");
}

function renderInstallScreen() {
  if (isBrowser) window.history.replaceState(null, "", "/");
  $("#installBack").classList.remove("hidden");
  const browserName = installGuideKind() === "chrome" ? "Chrome" : "Safari";
  $("#installPromptText").textContent = "For the best experience, add Split My Trip to your iPhone Home Screen so it opens like an app.";
  const steps = $$("#screen-install .install-steps li");
  if (steps[0]) steps[0].textContent = `Tap the Share icon in ${browserName}.`;
  if (steps[1]) steps[1].textContent = 'Scroll down and tap "Add to Home Screen."';
  if (steps[2]) steps[2].textContent = 'Tap "Add."';
  if (steps[3]) steps[3].textContent = "Open Split My Trip from the new Home Screen icon.";
}

async function loadAdminTrips() {
  const password = $("#adminPassword").value;
  try {
    const response = await api(`/api/admin/trips?password=${encodeURIComponent(password)}`);
    const accounts = await api(`/api/admin/accounts?password=${encodeURIComponent(password)}`);
    $("#adminLogin").classList.add("hidden");
    $("#adminPanel").classList.remove("hidden");
    $("#adminAccountsPanel").classList.remove("hidden");
    $("#adminOcrPanel").classList.remove("hidden");
    $("#adminTrips").innerHTML = response.trips.length
      ? response.trips
          .map(
            (trip) => `
              <article class="group-row">
                <div>
                  <div class="row-name">${escapeHtml(trip.name || "Trip")}</div>
                  <div class="subtext">${escapeHtml(trip.status || "active")} · ${trip.peopleCount || 0} people · ${trip.receiptCount || 0} receipts</div>
                </div>
                ${
                  trip.status === "deleted"
                    ? `<button class="small-primary" data-admin-restore="${trip.id}"><i data-lucide="rotate-ccw"></i><span>Recover</span></button>`
                    : `<button class="small-primary danger-action" data-admin-delete="${trip.id}"><i data-lucide="trash-2"></i><span>Delete</span></button>`
                }
              </article>
            `
          )
          .join("")
      : `<div class="empty">No trips found.</div>`;
    $$("[data-admin-delete]").forEach((button) => {
      button.addEventListener("click", () => deleteAdminTrip(button.dataset.adminDelete));
    });
    $$("[data-admin-restore]").forEach((button) => {
      button.addEventListener("click", () => restoreAdminTrip(button.dataset.adminRestore));
    });
    $("#adminAccountCount").textContent = String(accounts.accounts.length);
    $("#adminAccounts").innerHTML = accounts.accounts.length
      ? accounts.accounts
          .map(
            (account) => `
              <article class="group-row">
                <div>
                  <div class="row-name">${escapeHtml(account.name || account.email || "Account")}</div>
                  <div class="subtext">${escapeHtml(`${account.email || "No email"} · ${account.trips.length} trip${account.trips.length === 1 ? "" : "s"} · ${account.trips.map((trip) => trip.name).join(", ")}`)}</div>
                </div>
                <button class="small-primary danger-action" data-admin-account="${escapeHtml(account.id)}" data-admin-account-email="${escapeHtml(account.email || "")}" data-admin-participants="${escapeHtml(account.participantIds.join(","))}"><i data-lucide="user-x"></i><span>Delete</span></button>
              </article>
            `
          )
          .join("")
      : `<div class="empty">No accounts found.</div>`;
    $$("[data-admin-account]").forEach((button) => {
      button.addEventListener("click", () => deleteAdminAccount(button));
    });
    await loadAdminOcrUsage(password);
    makeIcons();
  } catch {
    safeAlert("Wrong password or admin API unavailable.");
  }
}

async function loadAdminOcrUsage(password = $("#adminPassword").value) {
  $("#adminOcrMonth").textContent = "This month";
  $("#adminOcrUsage").innerHTML = `<div class="empty">Loading OCR usage...</div>`;
  try {
    const ocrUsage = await api(`/api/admin/ocr-usage?password=${encodeURIComponent(password)}`);
    renderOcrUsageSummary(ocrUsage.usage, $("#adminOcrMonth"), $("#adminOcrUsage"));
  } catch (error) {
    renderOcrUsageError(readApiError(error));
  }
}

function renderOcrUsageError(message = "") {
  const setupRequired = /not set up|supabase-ocr-usage\.sql|ocr_usage/i.test(message);
  $("#adminOcrUsage").innerHTML = setupRequired
    ? `
        <div class="empty ocr-setup-empty">
          <strong>OCR usage tracking needs setup</strong>
          <span>Run <code>supabase-ocr-usage.sql</code> in Supabase, then refresh this panel.</span>
        </div>
      `
    : `<div class="empty">${escapeHtml(message || "OCR usage is unavailable.")}</div>`;
}

function renderOcrUsageSummary(usage, monthEl, targetEl) {
  if (!usage || !targetEl) return;
  const scope = "admin";
  if (monthEl) monthEl.textContent = formatOcrMonth(usage.month);
  const costLow = money.format(Number(usage.estimatedCostLow || 0));
  const costHigh = money.format(Number(usage.estimatedCostHigh || 0));
  const used = Number(usage.used || 0);
  const limit = Number(usage.limit || 0);
  const remaining = Number(usage.remaining || 0);
  targetEl.innerHTML = `
    <div class="total-row">
      <div>
        <div class="row-name">Requests used</div>
        <div class="subtext">Monthly limit ${limit.toLocaleString()}</div>
      </div>
      <div class="money">${used.toLocaleString()}</div>
    </div>
    <div class="total-row">
      <div>
        <div class="row-name">Successful scans</div>
        <div class="subtext">Scans returned by Google Document AI</div>
      </div>
      <div class="money positive">${Number(usage.successful || 0).toLocaleString()}</div>
    </div>
    <div class="total-row">
      <div>
        <div class="row-name">Failed scans</div>
        <div class="subtext">Requests sent but not completed</div>
      </div>
      <div class="money negative">${Number(usage.failed || 0).toLocaleString()}</div>
    </div>
    <div class="total-row">
      <div>
        <div class="row-name">Estimated OCR cost</div>
        <div class="subtext">Roughly $0.10-$0.20 per request</div>
      </div>
      <div class="money">${costLow}-${costHigh}</div>
    </div>
    <div class="total-row">
      <div>
        <div class="row-name">Last OCR scan</div>
        <div class="subtext">${usage.lastRequestAt ? formatDateTime(usage.lastRequestAt) : "No scans yet"}</div>
      </div>
      <div class="money">${remaining.toLocaleString()} left</div>
    </div>
    <div class="ocr-limit-card" data-ocr-scope="${scope}">
      <div>
        <div class="row-name">Monthly OCR limit</div>
        <div class="subtext">Updates apply immediately.</div>
      </div>
      <div class="ocr-limit-options" aria-label="OCR monthly limit options">
        ${[50, 100, 150, 200]
          .map((option) => `<button class="small-primary secondary-action ${option === limit ? "active" : ""}" data-ocr-limit="${option}" data-ocr-scope="${scope}">${option}</button>`)
          .join("")}
      </div>
      <label class="ocr-limit-custom">
        <span>Custom limit</span>
        <input id="${scope}OcrLimitInput" type="number" min="1" step="1" inputmode="numeric" value="${limit || 100}" />
      </label>
      <button class="primary full" data-ocr-save="${scope}"><i data-lucide="save"></i><span>Save monthly limit</span></button>
      <p class="subtext centered" id="${scope}OcrLimitStatus"></p>
    </div>
  `;
  bindOcrLimitControls(scope, monthEl, targetEl);
  makeIcons();
}

function formatOcrMonth(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return "This month";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function bindOcrLimitControls(scope, monthEl, targetEl) {
  const input = $(`#${scope}OcrLimitInput`);
  if (!input) return;
  $$(`[data-ocr-limit][data-ocr-scope="${scope}"]`).forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.ocrLimit || input.value;
      saveOcrLimit(scope, monthEl, targetEl);
    });
  });
  $$(`[data-ocr-save="${scope}"]`).forEach((button) => {
    button.addEventListener("click", () => saveOcrLimit(scope, monthEl, targetEl));
  });
}

async function saveOcrLimit(scope, monthEl, targetEl) {
  const input = $(`#${scope}OcrLimitInput`);
  const status = $(`#${scope}OcrLimitStatus`);
  const limit = Number(input?.value || 0);
  if (!Number.isFinite(limit) || limit < 1) {
    if (status) status.textContent = "Enter a limit of at least 1.";
    return;
  }
  if (status) status.textContent = "Saving...";
  try {
    const result = await api(`/api/admin/ocr-usage?password=${encodeURIComponent($("#adminPassword").value)}`, { method: "PATCH", body: { limit } });
    renderOcrUsageSummary(result.usage, monthEl, targetEl);
    const nextStatus = $(`#${scope}OcrLimitStatus`);
    if (nextStatus) nextStatus.textContent = "Saved.";
  } catch (error) {
    if (status) status.textContent = error.message || "Could not save OCR limit.";
  }
}

async function deleteAdminTrip(tripId) {
  if (!safeConfirm("Delete this trip and hide it from everyone?")) return;
  await api(`/api/admin/trips/${tripId}`, { method: "DELETE", body: { password: $("#adminPassword").value } });
  await loadAdminTrips();
}

async function restoreAdminTrip(tripId) {
  if (!safeConfirm("Recover this trip?")) return;
  await api(`/api/admin/trips/${tripId}/restore`, { method: "POST", body: { password: $("#adminPassword").value } });
  await loadAdminTrips();
}

async function deleteAdminAccount(button) {
  const email = button.dataset.adminAccountEmail || "";
  const participantIds = (button.dataset.adminParticipants || "").split(",").filter(Boolean);
  if (!safeConfirm(`Delete ${email || "this account"} from all listed trips?`)) return;
  await api("/api/admin/accounts", {
    method: "DELETE",
    body: { password: $("#adminPassword").value, email, participantIds },
  });
  await loadAdminTrips();
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
  cleanupKnownGroups(groups);
}

async function cleanupKnownGroups(groups) {
  if (!groups.length || knownGroupsCleanupInFlight) return;
  knownGroupsCleanupInFlight = true;
  const removed = [];
  try {
    await Promise.all(
      groups.map(async (group) => {
        try {
          await api(`/api/groups/${group.id}`);
        } catch (error) {
          if (/Group not found|404/i.test(error.message || "")) removed.push(group.id);
        }
      })
    );
    if (!removed.length) return;
    removed.forEach(forgetKnownGroup);
    renderGroups();
  } finally {
    knownGroupsCleanupInFlight = false;
  }
}

async function switchGroup(groupId) {
  const known = loadKnownGroups().find((group) => group.id === groupId);
  if (!known) return;
  activeGroupId = groupId;
  activePersonId = known.personId || readStorage(`trip-split-person-${groupId}`) || "";
  writeStorage("trip-split-group-id", groupId);
  if (activePersonId) writeStorage(`trip-split-person-${groupId}`, activePersonId);
  await initGroup();
  if (activePersonId) setAppGroupUrl();
  render();
  showScreen(activePersonId ? "home" : "join");
}

function renderPeopleOptions() {
  const manualPaidBy = $("#paidBy")?.value || "";
  const reviewPaidBy = $("#reviewPaidBy")?.value || "";
  const options = state.people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("");
  $("#paidBy").innerHTML = options;
  $("#reviewPaidBy").innerHTML = options;
  const validIds = new Set(state.people.map((person) => person.id));
  const fallbackPersonId = validIds.has(activePersonId) ? activePersonId : state.people[0]?.id || "";
  $("#paidBy").value = validIds.has(manualPaidBy) ? manualPaidBy : fallbackPersonId;
  $("#reviewPaidBy").value = validIds.has(reviewPaidBy) ? reviewPaidBy : fallbackPersonId;
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
  if (!activeGroupId || !activePersonId) return false;
  if (activeGroup?.ownerParticipantId && activeGroup.ownerParticipantId === activePersonId) return true;
  if (activeGroup?.ownerAccountId && accountProfile?.id && activeGroup.ownerAccountId === accountProfile.id) return true;
  if (!activeGroup?.ownerParticipantId && !activeGroup?.ownerAccountId && state.people[0]?.id === activePersonId) return true;
  return readStorage(`trip-split-owner-${activeGroupId}`) === activePersonId;
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
  const totalsList = $("#totalsList");
  if (!totalsList) return;
  const balances = calculateBalances();
  totalsList.innerHTML = state.people.length
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
    if (sort === "total") return Number(b.totalUsd || 0) - Number(a.totalUsd || 0);
    const aDate = sort === "receipt" ? a.date || a.createdAt : a.createdAt || a.date;
    const bDate = sort === "receipt" ? b.date || b.createdAt : b.createdAt || b.date;
    return new Date(bDate || 0) - new Date(aDate || 0);
  });
  $("#historyList").innerHTML = sortedReceipts.length
    ? sortedReceipts
        .map((receipt) => {
          const date = formatShortDate(receipt.date || receipt.createdAt);
          const status = isPendingReceipt(receipt) ? "Needs splitting" : "Complete";
          return `
            <article class="history-row">
              <div class="row-head">
                <div>
                  <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                  <div class="subtext">${date} · ${status}</div>
                </div>
                <div class="money">${money.format(receipt.totalUsd)}</div>
              </div>
              <div class="receipt-row-actions">
                ${
                  receipt.splitMode === "items"
                    ? `<button class="small-primary receipt-open" data-open-receipt="${receipt.id}"><i data-lucide="list-checks"></i><span>${isPendingReceipt(receipt) ? "Split now" : "Edit items"}</span></button>`
                    : ""
                }
                ${receipt.imageDataUrl ? `<button class="receipt-thumb history-thumb" data-preview-receipt="${receipt.id}" aria-label="Open ${escapeHtml(receipt.name || "Receipt")} photo"><img src="${receipt.imageDataUrl}" alt="${escapeHtml(receipt.name || "Receipt")} photo" loading="lazy" /></button>` : ""}
              </div>
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
  makeIcons();
}

function renderPendingReceipts() {
  const pending = state.receipts.filter(isPendingReceipt);
  $("#pendingPanel").classList.toggle("hidden", pending.length === 0);
  $("#pendingCount").textContent = `${pending.length}`;
  $("#pendingList").innerHTML = pending.length
    ? pending
        .map((receipt) => {
          return `
            <article class="pending-row">
              <div>
                <div class="row-name">${escapeHtml(receipt.name || "Receipt")}</div>
                <div class="subtext">${unassignedItemCount(receipt)} item${unassignedItemCount(receipt) === 1 ? "" : "s"} left</div>
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
  return (receipt.items || []).filter(itemHasUnassignedQuantity).length;
}

function itemHasUnassignedQuantity(item) {
  if (!(item.assignedTo || []).length) return true;
  const quantity = itemQuantity(item);
  if (quantity <= 1) return false;
  return sum(Object.values(item.claims || {})) < quantity;
}

function openReceiptForClaiming(receiptId) {
  const receipt = state.receipts.find((item) => item.id === receiptId);
  if (!receipt) return;
  editingReceiptId = receipt.id;
  parsedReceipt = JSON.parse(JSON.stringify(receipt));
  parsedReceipt.paidBy = receipt.paidBy;
  initiallyCoveredItemIds = new Set((parsedReceipt.items || []).filter((item) => !itemHasUnassignedQuantity(item)).map((item) => item.id));
  splitMode = "items";
  itemizeStage = "assign";
  setSplitMode("items");
  renderAssignment();
  showScreen("itemize");
}

function renderSettlements() {
  const settlements = calculateSettlements();
  const settledIds = settledSettlementIds();
  const active = settlements.filter((settlement) => !settledIds.includes(settlement.id));
  const archived = settlements.filter((settlement) => settledIds.includes(settlement.id));
  const receiveAmount = roundCents(sum(active.filter((settlement) => settlement.toId === activePersonId).map((settlement) => settlement.amount)));
  const oweAmount = roundCents(sum(active.filter((settlement) => settlement.fromId === activePersonId).map((settlement) => settlement.amount)));
  $("#settlementOwe").textContent = money.format(oweAmount);
  $("#settlementOwed").textContent = money.format(receiveAmount);
  updateSettleNavState(active.length);
  $("#settlementList").innerHTML = [
    active.length
      ? active
        .map(
          (settlement) => `
            <div class="settle-row">
              <div class="settle-copy">
                <div class="row-name">${escapeHtml(settlement.from)} pays ${escapeHtml(settlement.to)}</div>
                <div class="subtext">Final net settlement</div>
              </div>
              <div class="money settlement-amount">${money.format(settlement.amount)}</div>
              <button class="small-primary full settle-button" data-settle="${settlement.id}"><span>Tap to settle</span></button>
            </div>
          `
        )
        .join("")
      : `<div class="empty">No active payments due.</div>`,
    archived.length
      ? `<details class="settled-archive" data-settlement-archive ${settlementArchiveOpen ? "open" : ""}><summary>Settled archive (${archived.length})</summary><div class="settled-archive-list">${archived
          .map(
            (settlement) => `
              <div class="settle-row">
                <div class="settle-copy">
                  <div class="row-name">${escapeHtml(settlement.from)} paid ${escapeHtml(settlement.to)}</div>
                  <div class="subtext">Archived settlement</div>
                </div>
                <div class="money settlement-amount">${money.format(settlement.amount)}</div>
                <button class="small-primary full settle-button" data-unsettle="${settlement.id}"><span>Tap to unsettle</span></button>
              </div>
            `
          )
          .join("")}</div></details>`
      : "",
  ].join("");
  $("[data-settlement-archive]")?.addEventListener("toggle", (event) => {
    settlementArchiveOpen = event.currentTarget.open;
  });
  $$("[data-settle]").forEach((button) => button.addEventListener("click", () => markSettlement(button.dataset.settle, true)));
  $$("[data-unsettle]").forEach((button) => button.addEventListener("click", () => markSettlement(button.dataset.unsettle, false)));
}

function updateSettleNavState(activeSettlementCount) {
  const button = $('.quick-nav button[data-screen="settle"]');
  if (!button) return;
  const closed = isTripClosed();
  button.disabled = Boolean(closed && activeSettlementCount === 0);
  button.querySelector("span").textContent = closed && activeSettlementCount === 0 ? "All settled" : "Settle";
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
  const personId = activePersonId && state.people.some((person) => person.id === activePersonId) ? activePersonId : "";
  const person = findPerson(personId);
  const totals = personId ? personTotals(personId) : { owed: 0 };
  $("#loggedInAs").textContent = person ? `Logged in as ${person.name}` : accountProfile?.email ? `Signed in as ${accountProfile.email}` : "Not signed in";
  $("#personalTotal").textContent = `My share ${money.format(totals.owed)}`;
}

function renderExpenses() {
  const personId = activePersonId && state.people.some((person) => person.id === activePersonId) ? activePersonId : "";
  const person = findPerson(personId);
  const openExpenseIds = new Set($$("#expensesList [data-expense-details][open]").map((details) => details.dataset.expenseDetails));
  const rows = [];
  let total = 0;
  state.receipts.forEach((receipt) => {
    const items = (receipt.items || []).filter((item) => (item.assignedTo || []).includes(personId));
    if (!items.length) return;
    const itemNative = items.reduce((sumValue, item) => sumValue + itemShareForPerson(item, personId), 0);
    const native = Number(receipt.shares?.native?.[personId] || 0) || itemNative;
    total += toUsd(native, receipt.currency);
    rows.push({ receipt, items, native });
  });
  $("#expensesTitle").textContent = person ? `${possessive(person.name)} expenses` : "My expenses";
  $("#expensesTotal").textContent = money.format(total);
  $("#expensesBack")?.classList.toggle("hidden", expensesReturnHomeMode);
  $("#expensesHome")?.classList.toggle("hidden", !expensesReturnHomeMode);
  $("#expensesList").innerHTML = rows.length
    ? rows
        .map(
          ({ receipt, items, native }) => `
            <article class="history-row">
              <div class="row-head">
                <div>
                  <button class="text-link row-name" data-edit-expense="${receipt.id}">${escapeHtml(receipt.name || "Receipt")}</button>
                  <div class="subtext">${formatShortDate(receipt.date || receipt.createdAt, {})}</div>
                </div>
                <div class="money">${money.format(toUsd(native, receipt.currency))}</div>
              </div>
              <details class="settled-archive" data-expense-details="${receipt.id}" ${openExpenseIds.has(receipt.id) ? "open" : ""}>
                <summary>${items.length} item${items.length === 1 ? "" : "s"}</summary>
                ${items.map((item) => `<div class="fee-row"><span>${escapeHtml(expenseItemLabel(item, personId))}</span><strong>${formatNative(itemShareForPerson(item, personId), receipt.currency)}</strong></div>`).join("")}
              </details>
            </article>
          `
        )
        .join("")
    : `<div class="empty">Your accepted expenses will appear here.</div>`;

  $$("[data-edit-expense]").forEach((button) => {
    button.addEventListener("click", () => openReceiptForClaiming(button.dataset.editExpense));
  });
}

function expenseItemLabel(item, personId) {
  const claimQty = itemClaimQuantity(item, personId);
  return `${claimQty > 1 ? `${claimQty}x ` : ""}${item.name || "Item"}`;
}

function personTotals(personId) {
  let owed = 0;
  let paid = 0;
  let receiptCount = 0;
  state.receipts.forEach((receipt) => {
    const share = receiptShares(receipt).usd[personId] || 0;
    owed += share;
    if (share > 0) receiptCount += 1;
    if (receipt.paidBy === personId) paid += receipt.totalUsd;
  });
  return { owed, paid, receiptCount };
}

function receiptShares(receipt) {
  if ((receipt.items || []).length) return calculateItemShares(receipt);
  return receipt.shares || withUsd(emptyPersonMap(), receipt.currency || "USD");
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
    if (amount > 0) {
      settlements.push({
        id: `${debtor.person.id}-${creditor.person.id}-${amount}`,
        fromId: debtor.person.id,
        toId: creditor.person.id,
        from: debtor.person.name,
        to: creditor.person.name,
        amount,
      });
    }
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
  const code = supportedCurrencies.includes(currency) ? currency : "USD";
  const value = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: code === "VND" ? 0 : 2,
    maximumFractionDigits: code === "VND" ? 0 : 2,
  }).format(Number(amount || 0));
  return `${currencySymbol(code)}${value}`;
}

function currencySymbol(currency) {
  if (currency === "THB") return "฿";
  if (currency === "VND") return "₫";
  return "$";
}

function formatRate(currency, rate) {
  if (currency === "USD") return "$1";
  return `$1 = ${currencySymbol(currency)}${Number(rate).toLocaleString("en-US", { maximumFractionDigits: currency === "VND" ? 0 : 2 })}`;
}

function formatLongDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatShortDate(value, options = { month: "short", day: "numeric" }) {
  if (!value) return "";
  const date = parseDisplayDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, options);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function parseDisplayDate(value) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00`);
  return new Date(text);
}

function possessive(name) {
  const clean = String(name || "Your").trim();
  if (!clean || clean.toLowerCase() === "your") return "Your";
  return `${clean}${clean.endsWith("s") ? "'" : "'s"}`;
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase();
}

function completeInstallStep() {
  writeStorage(iosInstallChoiceKey, "done");
  showScreen(installReturnScreen || "home");
}

function skipInstallStep() {
  writeStorage(iosInstallChoiceKey, "done");
  showScreen(installReturnScreen || "home");
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
