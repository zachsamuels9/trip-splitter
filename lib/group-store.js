const crypto = require("crypto");

const memoryGroups = new Map();
const CLOSED_MARKER_NAME = "__trip_split_closed__";

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

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    people: group.people,
    receipts: group.receipts,
    ownerAccountId: group.ownerAccountId || "",
    ownerParticipantId: group.ownerParticipantId || "",
    closedAt: group.closedAt || null,
    status: group.status || (group.closedAt ? "closed" : "active"),
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

function passcodeHash(passcode) {
  return crypto.createHash("sha256").update(String(passcode || "")).digest("hex");
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 160);
}

function isValidPasscode(value) {
  return /^\d{4}$/.test(String(value || ""));
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

function cleanName(value, fallback, maxLength) {
  return String(value || fallback).trim().slice(0, maxLength) || fallback;
}

function isSupabaseUnavailable(error) {
  return !error.statusCode || error.statusCode === 503 || error.statusCode >= 500;
}

function isMissingColumn(error) {
  return /column .* does not exist|42703|PGRST204|schema cache|Could not find the .* column/i.test(error.message || "");
}

async function getGroup(id) {
  if (!supabaseEnv()) {
    const group = memoryGroups.get(id);
    return group?.status === "deleted" ? null : group || null;
  }

  try {
    const tripFilter = isUuid(id) ? `id=eq.${encodeURIComponent(id)}` : `invite_code=eq.${encodeURIComponent(id)}`;
    const trips = await supabase(`trips?${tripFilter}&limit=1`);
    const trip = trips?.[0];
    if (!trip) return null;
    if (trip.status === "deleted") return null;

    const [peopleRows, receiptRows] = await Promise.all([
      supabase(`participants?trip_id=eq.${trip.id}&order=created_at.asc`),
      supabase(`receipts?trip_id=eq.${trip.id}&order=created_at.desc`),
    ]);

    const closedMarker = receiptRows.find(isClosedMarker);
    const appReceiptRows = receiptRows.filter((receipt) => !isClosedMarker(receipt));
    const receiptIds = appReceiptRows.map((receipt) => receipt.id);
    const lineItems = receiptIds.length
      ? await supabase(`line_items?receipt_id=in.(${receiptIds.join(",")})&order=sort_order.asc`)
      : [];
    const lineItemIds = lineItems.map((item) => item.id);
    const [assignments, images] = await Promise.all([
      lineItemIds.length ? supabase(`assignments?line_item_id=in.(${lineItemIds.join(",")})`) : [],
      receiptIds.length ? supabase(`receipt_images?receipt_id=in.(${receiptIds.join(",")})&order=created_at.desc`) : [],
    ]);

    const people = peopleRows.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email || "",
      accountId: person.account_id || "",
      createdAt: person.created_at,
    }));
    const receipts = appReceiptRows.map((receipt) => receiptFromRows(receipt, lineItems, assignments, images, people));
    const closedAt = trip.closed_at || closedMarker?.created_at || null;

    return publicGroup({
      id: trip.id,
      name: trip.name,
      people,
      receipts,
      ownerAccountId: trip.owner_account_id || "",
      ownerParticipantId: trip.owner_participant_id || "",
      closedAt,
      status: trip.status || (closedAt ? "closed" : "active"),
      createdAt: trip.created_at,
      updatedAt: trip.updated_at,
    });
  } catch (error) {
    if (isSupabaseUnavailable(error)) return memoryGroups.get(id) || null;
    throw error;
  }
}

async function createGroup({ name, personName, personEmail, passcode }) {
  if (!supabaseEnv()) return createMemoryGroup({ name, personName, personEmail, passcode });

  try {
    const account = await upsertAccount({ name: personName || "You", email: personEmail, passcode });
    const tripRows = await insertTrip({ name: cleanName(name, "Trip group", 80), ownerAccountId: account?.id || "" });
    const trip = tripRows[0];
    const person = createPerson(personName || "You");
    const personBody = { id: person.id, trip_id: trip.id, name: person.name };
    addAccountFields(personBody, { email: personEmail, passcode });
    if (account?.id) personBody.account_id = account.id;
    await insertParticipant(personBody);
    await setTripOwner(trip.id, { ownerAccountId: account?.id || "", ownerParticipantId: person.id });

    const group = await getRequiredGroup(trip.id);
    return { group, person, account: account ? accountProfile(account) : null };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return createMemoryGroup({ name, personName, personEmail, passcode });
    throw error;
  }
}

async function insertTrip({ name, ownerAccountId = "" }) {
  const body = { name };
  if (ownerAccountId) body.owner_account_id = ownerAccountId;
  try {
    return await supabase("trips", {
      method: "POST",
      prefer: "return=representation",
      body,
    });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    delete body.owner_account_id;
    return supabase("trips", {
      method: "POST",
      prefer: "return=representation",
      body,
    });
  }
}

async function setTripOwner(tripId, { ownerAccountId = "", ownerParticipantId = "" }) {
  const body = {};
  if (ownerAccountId) body.owner_account_id = ownerAccountId;
  if (ownerParticipantId) body.owner_participant_id = ownerParticipantId;
  if (!Object.keys(body).length) return;
  await supabase(`trips?id=eq.${tripId}`, {
    method: "PATCH",
    body,
  }).catch((error) => {
    if (!isMissingColumn(error)) throw error;
  });
}

async function addPerson(groupId, name, account = {}) {
  if (!supabaseEnv()) return addMemoryPerson(groupId, name, account);

  try {
    const group = await getRequiredGroup(groupId);
    const accountRow = await upsertAccount({ name, email: account.email, passcode: account.passcode });
    const person = createPerson(name);
    const personBody = { id: person.id, trip_id: group.id, name: person.name };
    addAccountFields(personBody, account);
    if (accountRow?.id) personBody.account_id = accountRow.id;
    await insertParticipant(personBody);
    return { group: await getRequiredGroup(group.id), person, account: accountRow ? accountProfile(accountRow) : null };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return addMemoryPerson(groupId, name, account);
    throw error;
  }
}

function addAccountFields(body, account = {}) {
  const email = cleanEmail(account.email || account.personEmail);
  if (email) body.email = email;
  if (isValidPasscode(account.passcode)) body.passcode_hash = passcodeHash(account.passcode);
}

async function upsertAccount({ name, email, passcode }) {
  const clean = cleanEmail(email);
  if (!clean || !isValidPasscode(passcode)) return null;
  const body = {
    name: cleanName(name, "Traveler", 80),
    email: clean,
    passcode_hash: passcodeHash(passcode),
    updated_at: new Date().toISOString(),
  };
  try {
    const existing = await supabase(`accounts?email=eq.${encodeURIComponent(clean)}&limit=1`);
    if (existing?.[0]) {
      const rows = await supabase(`accounts?id=eq.${existing[0].id}`, {
        method: "PATCH",
        prefer: "return=representation",
        body,
      });
      return rows?.[0] || existing[0];
    }
    const rows = await supabase("accounts", {
      method: "POST",
      prefer: "return=representation",
      body,
    });
    return rows?.[0] || null;
  } catch (error) {
    if (isMissingColumn(error) || /accounts/i.test(error.message || "")) return null;
    throw error;
  }
}

async function insertParticipant(body) {
  try {
    return await supabase("participants", {
      method: "POST",
      prefer: "return=representation",
      body,
    });
  } catch (error) {
    if (!isMissingColumn(error) || (!("email" in body) && !("passcode_hash" in body))) throw error;
    const fallback = { ...body };
    if (/account_id/i.test(error.message || "")) {
      delete fallback.account_id;
    } else {
      delete fallback.email;
      delete fallback.passcode_hash;
      delete fallback.account_id;
    }
    console.warn("[accounts] participants email/passcode columns missing; created name-only participant.");
    return supabase("participants", {
      method: "POST",
      prefer: "return=representation",
      body: fallback,
    });
  }
}

async function signInAccount({ email, passcode }) {
  const clean = cleanEmail(email);
  if (!clean || !isValidPasscode(passcode)) {
    const error = new Error("Enter your email and 4-digit passcode.");
    error.statusCode = 400;
    throw error;
  }
  if (!supabaseEnv()) {
    const trips = [...memoryGroups.values()]
      .filter((group) => group.status !== "deleted")
      .map((group) => {
        const person = group.people.find((entry) => cleanEmail(entry.email) === clean && entry.passcodeHash === passcodeHash(passcode));
        return person ? { id: group.id, name: group.name, personId: person.id, personName: person.name, updatedAt: group.updatedAt } : null;
      })
      .filter(Boolean);
    return { account: trips[0] || null, trips };
  }
  try {
    const account = await findAccount(clean, passcode);
    let rows = [];
    if (account?.id) {
      rows = await supabase(`participants?account_id=eq.${account.id}&select=id,name,email,trip_id,account_id`).catch((error) => {
        if (isMissingColumn(error)) return [];
        throw error;
      });
    }
    if (!rows.length) rows = await supabase(`participants?email=eq.${encodeURIComponent(clean)}&passcode_hash=eq.${passcodeHash(passcode)}&select=id,name,email,trip_id`);
    const tripIds = rows.map((row) => row.trip_id).filter(Boolean);
    let trips = [];
    if (tripIds.length) {
      try {
        trips = await supabase(`trips?id=in.(${tripIds.join(",")})&select=id,name,updated_at,status`);
      } catch (error) {
        if (!isMissingColumn(error)) throw error;
        trips = await supabase(`trips?id=in.(${tripIds.join(",")})&select=id,name,updated_at`);
      }
    }
    const byTripId = Object.fromEntries(trips.filter((trip) => trip.status !== "deleted").map((trip) => [trip.id, trip]));
    const activeRows = rows
      .filter((row) => byTripId[row.trip_id])
      .sort((a, b) => new Date(byTripId[b.trip_id]?.updated_at || 0) - new Date(byTripId[a.trip_id]?.updated_at || 0));
    return {
      account: account ? accountProfile(account) : rows[0] ? participantAccount(rows[0], byTripId[rows[0].trip_id]) : null,
      trips: activeRows.map((row) => participantAccount(row, byTripId[row.trip_id])),
    };
  } catch (error) {
    if (isMissingColumn(error)) {
      const migrationError = new Error("Account sign-in requires running supabase-account-migration.sql.");
      migrationError.statusCode = 503;
      throw migrationError;
    }
    throw error;
  }
}

async function findAccount(email, passcode) {
  try {
    const rows = await supabase(`accounts?email=eq.${encodeURIComponent(email)}&passcode_hash=eq.${passcodeHash(passcode)}&limit=1`);
    return rows?.[0] || null;
  } catch (error) {
    if (isMissingColumn(error) || /accounts/i.test(error.message || "")) return null;
    throw error;
  }
}

function accountProfile(row) {
  return {
    id: row.id,
    name: row.name || "",
    personId: "",
    personName: row.name || "",
    email: row.email || "",
    updatedAt: row.updated_at || "",
  };
}

async function updateAccount(participantId, updates = {}) {
  if (!supabaseEnv()) {
    const person = [...memoryGroups.values()].flatMap((group) => group.people).find((entry) => entry.id === participantId);
    if (!person) return notFound();
    if (updates.name) person.name = cleanName(updates.name, person.name, 60);
    if (updates.email) person.email = cleanEmail(updates.email);
    if (isValidPasscode(updates.passcode)) person.passcodeHash = passcodeHash(updates.passcode);
    return { account: person };
  }
  const body = {};
  if (updates.name) body.name = cleanName(updates.name, "Guest", 60);
  if (updates.email) body.email = cleanEmail(updates.email);
  if (isValidPasscode(updates.passcode)) body.passcode_hash = passcodeHash(updates.passcode);
  if (!Object.keys(body).length) return { ok: true };
  try {
    const rows = await supabase(`participants?id=eq.${participantId}`, {
      method: "PATCH",
      prefer: "return=representation",
      body,
    });
    return { account: rows?.[0] || null };
  } catch (error) {
    if (isMissingColumn(error)) {
      const migrationError = new Error("Account updates require running supabase-account-migration.sql.");
      migrationError.statusCode = 503;
      throw migrationError;
    }
    throw error;
  }
}

function participantAccount(row, trip = null) {
  return {
    id: trip?.id || row.trip_id,
    name: trip?.name || "Trip group",
    personId: row.id,
    personName: row.name,
    email: row.email,
    updatedAt: trip?.updated_at || "",
  };
}

async function upsertReceipt(groupId, receipt) {
  if (!receipt?.id) {
    const error = new Error("Receipt is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!supabaseEnv()) return upsertMemoryReceipt(groupId, receipt);

  try {
    const group = await getRequiredGroup(groupId);
    const adjustments = splitAdjustments(receipt);
    const subtotal = sum((receipt.items || []).map((item) => item.amount));
    const total = Math.max(0, subtotal + adjustments.tip + adjustments.tax + adjustments.fees - (receipt.discount || 0));

    await supabase("receipts?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        id: receipt.id,
        trip_id: group.id,
        paid_by_participant_id: isUuid(receipt.paidBy) ? receipt.paidBy : null,
        name: cleanName(receipt.name, "Receipt", 120),
        merchant: receipt.restaurantName || null,
        receipt_date: receipt.date || null,
        location: receipt.location || null,
        description: receipt.description || null,
        currency: receipt.currency || "USD",
        subtotal,
        tax: adjustments.tax,
        tip: adjustments.tip,
        fees: adjustments.fees,
        discount: receipt.discount || 0,
        total,
        source: receipt.source || "manual",
        split_mode: receipt.splitMode || "items",
      },
    });

    await supabase(`line_items?receipt_id=eq.${receipt.id}`, { method: "DELETE" });
    await writeLineItems(receipt);
    await writeReceiptImage(group.id, receipt);

    const updatedGroup = await getRequiredGroup(group.id);
    await writeBalancesAndSettlements(updatedGroup);
    return { group: await getRequiredGroup(group.id), receipt };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return upsertMemoryReceipt(groupId, receipt);
    throw error;
  }
}

async function closeGroup(groupId) {
  if (!supabaseEnv()) return closeMemoryGroup(groupId);

  const group = await getRequiredGroup(groupId);
  try {
    await supabase(`trips?id=eq.${group.id}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "closed", closed_at: new Date().toISOString() },
    });
    await writeClosedMarker(group.id).catch(() => null);
    return { group: await getRequiredGroup(group.id) };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return closeMemoryGroup(groupId);
    if (isMissingColumn(error)) {
      await writeClosedMarker(group.id);
      return { group: await getRequiredGroup(group.id) };
    }
    throw error;
  }
}

async function reopenGroup(groupId) {
  if (!supabaseEnv()) return reopenMemoryGroup(groupId);

  const group = await getRequiredGroup(groupId);
  try {
    await supabase(`trips?id=eq.${group.id}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "active", closed_at: null },
    });
    await deleteClosedMarker(group.id).catch(() => null);
    return { group: await getRequiredGroup(group.id) };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return reopenMemoryGroup(groupId);
    if (isMissingColumn(error)) {
      await deleteClosedMarker(group.id);
      return { group: await getRequiredGroup(group.id) };
    }
    throw error;
  }
}

async function listTrips() {
  if (!supabaseEnv()) {
    return {
      trips: [...memoryGroups.values()].map((group) => ({
        id: group.id,
        name: group.name,
        status: group.status || "active",
        peopleCount: group.people.length,
        receiptCount: group.receipts.length,
        updatedAt: group.updatedAt,
      })),
    };
  }

  let trips;
  try {
    trips = await supabase("trips?select=id,name,updated_at,status&order=updated_at.desc");
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    trips = await supabase("trips?select=id,name,updated_at&order=updated_at.desc");
  }
  const [participants, receipts] = await Promise.all([supabase("participants?select=trip_id"), supabase("receipts?select=trip_id,name,source,created_at")]);
  return {
    trips: trips.map((trip) => ({
      id: trip.id,
      name: trip.name,
      status: trip.status === "deleted" ? "deleted" : receipts.some((receipt) => receipt.trip_id === trip.id && isClosedMarker(receipt)) ? "closed" : "active",
      peopleCount: participants.filter((person) => person.trip_id === trip.id).length,
      receiptCount: receipts.filter((receipt) => receipt.trip_id === trip.id && !isClosedMarker(receipt)).length,
      updatedAt: trip.updated_at,
    })),
  };
}

async function listAccounts() {
  if (!supabaseEnv()) {
    const accounts = [];
    memoryGroups.forEach((group) => {
      group.people.forEach((person) => {
        accounts.push({
          id: person.email || person.id,
          email: person.email || "",
          name: person.name,
          trips: [{ id: group.id, name: group.name }],
          participantIds: [person.id],
        });
      });
    });
    return { accounts: mergeAccountRows(accounts) };
  }

  let participants;
  try {
    participants = await supabase("participants?select=id,name,email,trip_id&order=created_at.desc");
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    participants = await supabase("participants?select=id,name,trip_id&order=created_at.desc");
  }
  const tripIds = Array.from(new Set(participants.map((person) => person.trip_id).filter(Boolean)));
  const trips = tripIds.length ? await supabase(`trips?id=in.(${tripIds.join(",")})&select=id,name`) : [];
  const tripsById = Object.fromEntries(trips.map((trip) => [trip.id, trip]));
  return {
    accounts: mergeAccountRows(
      participants.map((person) => ({
        id: person.email || person.id,
        email: person.email || "",
        name: person.name,
        trips: person.trip_id ? [{ id: person.trip_id, name: tripsById[person.trip_id]?.name || "Trip" }] : [],
        participantIds: [person.id],
      }))
    ),
  };
}

function mergeAccountRows(rows) {
  const accounts = new Map();
  rows.forEach((row) => {
    const key = row.email || row.participantIds[0];
    const account = accounts.get(key) || { id: key, email: row.email, name: row.name, trips: [], participantIds: [] };
    account.name = account.name || row.name;
    account.trips.push(...row.trips);
    account.participantIds.push(...row.participantIds);
    accounts.set(key, account);
  });
  return Array.from(accounts.values()).map((account) => ({
    ...account,
    trips: account.trips.filter((trip, index, trips) => trips.findIndex((item) => item.id === trip.id) === index),
  }));
}

async function deleteAccount({ email, participantIds = [] }) {
  if (!supabaseEnv()) {
    const ids = new Set(participantIds);
    memoryGroups.forEach((group) => {
      group.people = group.people.filter((person) => {
        if (email && person.email === email) return false;
        return !ids.has(person.id);
      });
      group.receipts.forEach((receipt) => {
        if (ids.has(receipt.paidBy)) receipt.paidBy = "";
        receipt.items.forEach((item) => {
          item.assignedTo = (item.assignedTo || []).filter((id) => !ids.has(id));
          Object.keys(item.claims || {}).forEach((id) => {
            if (ids.has(id)) delete item.claims[id];
          });
        });
      });
    });
    return { ok: true };
  }

  let ids = participantIds.filter(isUuid);
  if (email) {
    const rows = await supabase(`participants?email=eq.${encodeURIComponent(cleanEmail(email))}&select=id`).catch((error) => {
      if (isMissingColumn(error)) return [];
      throw error;
    });
    ids = Array.from(new Set([...ids, ...rows.map((row) => row.id)]));
  }
  if (!ids.length) return { ok: true };
  const idFilter = ids.join(",");
  await supabase(`assignments?participant_id=in.(${idFilter})`, { method: "DELETE" }).catch(() => null);
  await supabase(`receipts?paid_by_participant_id=in.(${idFilter})`, {
    method: "PATCH",
    body: { paid_by_participant_id: null },
  }).catch(() => null);
  await supabase(`participants?id=in.(${idFilter})`, { method: "DELETE" });
  return { ok: true };
}

async function removePerson(groupId, participantId) {
  if (!groupId || !participantId) return notFound();
  const group = await getRequiredGroup(groupId);
  if (group.ownerParticipantId === participantId) {
    const error = new Error("Trip owner cannot leave the trip.");
    error.statusCode = 403;
    throw error;
  }

  if (!supabaseEnv()) {
    const memoryGroup = memoryGroups.get(group.id || groupId);
    if (!memoryGroup) return notFound();
    removePersonFromMemoryGroup(memoryGroup, participantId);
    memoryGroup.updatedAt = new Date().toISOString();
    return { group: publicGroup(memoryGroup) };
  }

  if (!isUuid(group.id) || !isUuid(participantId)) return notFound();
  await supabase(`assignments?participant_id=eq.${encodeURIComponent(participantId)}`, { method: "DELETE" }).catch(() => null);
  await supabase(`receipts?trip_id=eq.${encodeURIComponent(group.id)}&paid_by_participant_id=eq.${encodeURIComponent(participantId)}`, {
    method: "PATCH",
    body: { paid_by_participant_id: null },
  }).catch(() => null);
  await supabase(`participants?id=eq.${encodeURIComponent(participantId)}&trip_id=eq.${encodeURIComponent(group.id)}`, { method: "DELETE" });
  return { group: await getRequiredGroup(group.id) };
}

function removePersonFromMemoryGroup(group, participantId) {
  const ids = new Set([participantId]);
  group.people = group.people.filter((person) => !ids.has(person.id));
  group.receipts.forEach((receipt) => {
    if (ids.has(receipt.paidBy)) receipt.paidBy = "";
    receipt.items.forEach((item) => {
      item.assignedTo = (item.assignedTo || []).filter((id) => !ids.has(id));
      Object.keys(item.claims || {}).forEach((id) => {
        if (ids.has(id)) delete item.claims[id];
      });
    });
  });
}

async function writeClosedMarker(groupId) {
  await deleteClosedMarker(groupId).catch(() => null);
  const today = new Date().toISOString().slice(0, 10);
  await supabase("receipts", {
    method: "POST",
    prefer: "return=representation",
    body: {
      id: crypto.randomUUID(),
      trip_id: groupId,
      paid_by_participant_id: null,
      name: CLOSED_MARKER_NAME,
      merchant: null,
      receipt_date: today,
      location: null,
      description: "Trip closed",
      currency: "USD",
      subtotal: 0,
      tax: 0,
      tip: 0,
      fees: 0,
      discount: 0,
      total: 0,
      source: "system",
      split_mode: "items",
    },
  });
}

async function deleteClosedMarker(groupId) {
  await supabase(`receipts?trip_id=eq.${groupId}&name=eq.${encodeURIComponent(CLOSED_MARKER_NAME)}`, { method: "DELETE" });
}

function isClosedMarker(receipt) {
  return receipt?.name === CLOSED_MARKER_NAME || (receipt?.source === "system" && receipt?.description === "Trip closed");
}

async function deleteTrip(groupId) {
  if (!supabaseEnv()) {
    const group = memoryGroups.get(groupId);
    if (!group) return notFound();
    group.status = "deleted";
    group.deletedAt = new Date().toISOString();
    group.updatedAt = group.deletedAt;
    return { ok: true };
  }

  const trips = await supabase(`trips?id=eq.${encodeURIComponent(groupId)}&limit=1`);
  const group = trips?.[0];
  if (!group) return notFound();
  try {
    await supabase(`trips?id=eq.${group.id}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "deleted", updated_at: new Date().toISOString() },
    });
  } catch (error) {
    try {
      await hardDeleteTrip(group.id);
    } catch {
      throw error;
    }
  }
  return { ok: true };
}

async function hardDeleteTrip(groupId) {
  const receipts = await supabase(`receipts?trip_id=eq.${groupId}&select=id`);
  const receiptIds = receipts.map((receipt) => receipt.id);
  if (receiptIds.length) {
    const lineItems = await supabase(`line_items?receipt_id=in.(${receiptIds.join(",")})&select=id`);
    const lineItemIds = lineItems.map((item) => item.id);
    if (lineItemIds.length) await supabase(`assignments?line_item_id=in.(${lineItemIds.join(",")})`, { method: "DELETE" });
    await supabase(`line_items?receipt_id=in.(${receiptIds.join(",")})`, { method: "DELETE" });
    await supabase(`receipt_images?receipt_id=in.(${receiptIds.join(",")})`, { method: "DELETE" });
  }
  await supabase(`settlements?trip_id=eq.${groupId}`, { method: "DELETE" }).catch(() => null);
  await supabase(`balances?trip_id=eq.${groupId}`, { method: "DELETE" }).catch(() => null);
  await supabase(`receipts?trip_id=eq.${groupId}`, { method: "DELETE" });
  await supabase(`trips?id=eq.${groupId}`, { method: "DELETE" }).catch(() => null);
}

async function restoreTrip(groupId) {
  if (!supabaseEnv()) {
    const group = memoryGroups.get(groupId);
    if (!group) return notFound();
    group.status = "active";
    group.deletedAt = null;
    group.updatedAt = new Date().toISOString();
    return { ok: true };
  }

  const trips = await supabase(`trips?id=eq.${encodeURIComponent(groupId)}&limit=1`);
  const group = trips?.[0];
  if (!group) return notFound();
  await supabase(`trips?id=eq.${group.id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "active", updated_at: new Date().toISOString() },
  });
  return { ok: true };
}

async function resetTrip(groupId) {
  if (!supabaseEnv()) {
    const group = memoryGroups.get(groupId);
    if (!group) return notFound();
    group.receipts = [];
    group.updatedAt = new Date().toISOString();
    return { group: publicGroup(group) };
  }

  const group = await getRequiredGroup(groupId);
  const receipts = await supabase(`receipts?trip_id=eq.${group.id}&select=id`);
  const receiptIds = receipts.map((receipt) => receipt.id);
  if (receiptIds.length) {
    const lineItems = await supabase(`line_items?receipt_id=in.(${receiptIds.join(",")})&select=id`);
    const lineItemIds = lineItems.map((item) => item.id);
    if (lineItemIds.length) await supabase(`assignments?line_item_id=in.(${lineItemIds.join(",")})`, { method: "DELETE" });
    await supabase(`line_items?receipt_id=in.(${receiptIds.join(",")})`, { method: "DELETE" });
    await supabase(`receipt_images?receipt_id=in.(${receiptIds.join(",")})`, { method: "DELETE" });
    await supabase(`receipts?id=in.(${receiptIds.join(",")})`, { method: "DELETE" });
  }
  await supabase(`settlements?trip_id=eq.${group.id}`, { method: "DELETE" }).catch(() => null);
  await supabase(`balances?trip_id=eq.${group.id}`, { method: "DELETE" }).catch(() => null);
  return { group: await getRequiredGroup(group.id) };
}

async function writeLineItems(receipt) {
  const items = receipt.items || [];
  if (!items.length) return;
  const rows = items.map((item, index) => ({
    id: item.id,
    receipt_id: receipt.id,
    name: cleanName(item.name, "Item", 160),
    quantity: item.quantity || 1,
    unit_price: item.unitPrice || (item.quantity ? (item.amount || 0) / item.quantity : item.amount || 0),
    amount: item.amount || 0,
    sort_order: index,
  }));
  await supabase("line_items", { method: "POST", prefer: "return=representation", body: rows });

  const assignmentRows = items.flatMap((item) =>
    (item.assignedTo || []).filter(isUuid).map((participantId) => ({
      line_item_id: item.id,
      participant_id: participantId,
      share_amount: itemShareAmount(item, participantId),
    }))
  );
  if (assignmentRows.length) {
    await supabase("assignments", { method: "POST", prefer: "return=representation", body: assignmentRows });
  }
}

function itemShareAmount(item, participantId) {
  const quantity = Math.max(1, Number(item.quantity || 1));
  const claims = item.claims || {};
  const claimed = Number(claims[participantId] || 0);
  const claimedTotal = sum(Object.values(claims));
  if (claimed > 0) return (item.amount || 0) * (claimed / quantity);
  if (quantity > 1 && claimedTotal > 0) return 0;
  return item.assignedTo?.length ? (item.amount || 0) / item.assignedTo.length : null;
}

async function writeReceiptImage(tripId, receipt) {
  await supabase(`receipt_images?receipt_id=eq.${receipt.id}`, { method: "DELETE" });
  if (!receipt.imageDataUrl) return;
  await supabase("receipt_images", {
    method: "POST",
    prefer: "return=representation",
    body: {
      trip_id: tripId,
      receipt_id: receipt.id,
      public_url: receipt.imageDataUrl,
      mime_type: receipt.imageDataUrl.match(/^data:([^;]+)/)?.[1] || null,
    },
  });
}

function receiptFromRows(receipt, lineItems, assignments, images, people) {
  const items = lineItems
    .filter((item) => item.receipt_id === receipt.id)
    .map((item) => {
      const itemAssignments = assignments.filter((assignment) => assignment.line_item_id === item.id);
      const quantity = Number(item.quantity || 1);
      const unitPrice = Number(item.unit_price || (quantity ? Number(item.amount || 0) / quantity : item.amount || 0));
      const claims =
        quantity > 1
          ? Object.fromEntries(
              itemAssignments
                .map((assignment) => [assignment.participant_id, unitPrice ? Math.round(Number(assignment.share_amount || 0) / unitPrice) : 0])
                .filter(([, claim]) => claim > 0)
            )
          : {};
      return {
        id: item.id,
        name: item.name,
        amount: Number(item.amount || 0),
        quantity,
        unitPrice,
        claims,
        assignedTo: itemAssignments.map((assignment) => assignment.participant_id),
      };
    });
  const appReceipt = {
    id: receipt.id,
    createdAt: receipt.created_at,
    currency: receipt.currency || "USD",
    name: receipt.name || "Receipt",
    date: receipt.receipt_date,
    location: receipt.location || "",
    description: receipt.description || "",
    restaurantName: receipt.merchant || "",
    imageDataUrl: images.find((image) => image.receipt_id === receipt.id)?.public_url || "",
    paidBy: receipt.paid_by_participant_id || "",
    splitMode: receipt.split_mode || "items",
    splitCount: people.length || 1,
    assignmentStatus: items.some(itemHasUnassignedQuantity) ? "pending" : "complete",
    items,
    fees: adjustmentRows(receipt),
    discount: Number(receipt.discount || 0),
    totalNative: Number(receipt.total || 0),
    totalUsd: Number(receipt.total || 0),
    rateUsed: 1,
  };
  appReceipt.shares = calculateShares(appReceipt, people);
  return appReceipt;
}

function adjustmentRows(receipt) {
  return [
    Number(receipt.tip || 0) > 0 ? { id: `${receipt.id}-tip`, name: "Tip", amount: Number(receipt.tip || 0) } : null,
    Number(receipt.tax || 0) > 0 ? { id: `${receipt.id}-tax`, name: "Tax", amount: Number(receipt.tax || 0) } : null,
    Number(receipt.fees || 0) > 0 ? { id: `${receipt.id}-fees`, name: "Fees", amount: Number(receipt.fees || 0) } : null,
  ].filter(Boolean);
}

function splitAdjustments(receipt) {
  const result = { tip: 0, tax: 0, fees: 0 };
  (receipt.fees || []).forEach((fee) => {
    if (/tip|gratuity/i.test(fee.name)) result.tip += Number(fee.amount || 0);
    else if (/tax|vat|gst/i.test(fee.name)) result.tax += Number(fee.amount || 0);
    else result.fees += Number(fee.amount || 0);
  });
  return result;
}

function calculateShares(receipt, people) {
  const native = Object.fromEntries(people.map((person) => [person.id, 0]));
  receipt.items.forEach((item) => {
    const assignedTo = item.assignedTo || [];
    if (!assignedTo.length) return;
    assignedTo.forEach((participantId) => {
      native[participantId] = (native[participantId] || 0) + itemShareAmount(item, participantId);
    });
  });
  const subtotal = sum(Object.values(native));
  const adjustments = sum((receipt.fees || []).map((fee) => fee.amount)) - (receipt.discount || 0);
  if (subtotal > 0 && adjustments !== 0) {
    Object.keys(native).forEach((participantId) => {
      native[participantId] += adjustments * (native[participantId] / subtotal);
    });
  }
  return { native, usd: { ...native } };
}

async function writeBalancesAndSettlements(group) {
  const balances = {};
  group.people.forEach((person) => {
    balances[person.id] = { participant: person, paid: 0, owed: 0, net: 0 };
  });
  group.receipts.forEach((receipt) => {
    if (isPendingReceipt(receipt)) return;
    Object.entries(receipt.shares?.usd || {}).forEach(([participantId, amount]) => {
      if (balances[participantId]) balances[participantId].owed += Number(amount || 0);
    });
    if (balances[receipt.paidBy]) balances[receipt.paidBy].paid += Number(receipt.totalUsd || 0);
  });
  Object.values(balances).forEach((balance) => {
    balance.net = roundCents(balance.paid - balance.owed);
  });

  const balanceRows = Object.values(balances).map((balance) => ({
    trip_id: group.id,
    participant_id: balance.participant.id,
    paid_total: roundCents(balance.paid),
    owed_total: roundCents(balance.owed),
    net_total: balance.net,
    currency: "USD",
  }));
  if (balanceRows.length) {
    await supabase("balances?on_conflict=trip_id,participant_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: balanceRows,
    });
  }

  await supabase(`settlements?trip_id=eq.${group.id}`, { method: "DELETE" });
  const settlements = calculateSettlements(Object.values(balances));
  if (settlements.length) {
    await supabase("settlements", {
      method: "POST",
      prefer: "return=representation",
      body: settlements.map((settlement) => ({
        trip_id: group.id,
        from_participant_id: settlement.from,
        to_participant_id: settlement.to,
        amount: settlement.amount,
        currency: "USD",
        status: "suggested",
      })),
    });
  }
}

function isPendingReceipt(receipt) {
  return (receipt.items || []).some(itemHasUnassignedQuantity);
}

function itemHasUnassignedQuantity(item) {
  if (!(item.assignedTo || []).length) return true;
  const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
  if (quantity <= 1) return false;
  return sum(Object.values(item.claims || {})) < quantity;
}

function calculateSettlements(balances) {
  const debtors = balances.filter((balance) => balance.net < -0.005).map((balance) => ({ id: balance.participant.id, amount: Math.abs(balance.net) }));
  const creditors = balances.filter((balance) => balance.net > 0.005).map((balance) => ({ id: balance.participant.id, amount: balance.net }));
  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = roundCents(Math.min(debtor.amount, creditor.amount));
    if (amount > 0) settlements.push({ from: debtor.id, to: creditor.id, amount });
    debtor.amount = roundCents(debtor.amount - amount);
    creditor.amount = roundCents(creditor.amount - amount);
    if (debtor.amount <= 0.005) debtorIndex += 1;
    if (creditor.amount <= 0.005) creditorIndex += 1;
  }
  return settlements;
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

function createMemoryGroup({ name, personName }) {
  const person = createPerson(personName || "You");
  if (arguments[0]?.personEmail) person.email = cleanEmail(arguments[0].personEmail);
  if (isValidPasscode(arguments[0]?.passcode)) person.passcodeHash = passcodeHash(arguments[0].passcode);
  const group = {
    id: crypto.randomUUID(),
    name: cleanName(name, "Trip group", 80),
    people: [person],
    receipts: [],
    ownerAccountId: "",
    ownerParticipantId: person.id,
    closedAt: null,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memoryGroups.set(group.id, group);
  return { group: publicGroup(group), person };
}

function closeMemoryGroup(groupId) {
  const group = memoryGroups.get(groupId);
  if (!group) return notFound();
  group.closedAt = new Date().toISOString();
  group.status = "closed";
  group.updatedAt = new Date().toISOString();
  return { group: publicGroup(group) };
}

function reopenMemoryGroup(groupId) {
  const group = memoryGroups.get(groupId);
  if (!group) return notFound();
  group.closedAt = null;
  group.status = "active";
  group.updatedAt = new Date().toISOString();
  return { group: publicGroup(group) };
}

function addMemoryPerson(groupId, name, account = {}) {
  const group = memoryGroups.get(groupId);
  if (!group) return notFound();
  const person = createPerson(name);
  if (account.email) person.email = cleanEmail(account.email);
  if (isValidPasscode(account.passcode)) person.passcodeHash = passcodeHash(account.passcode);
  group.people.push(person);
  group.updatedAt = new Date().toISOString();
  return { group: publicGroup(group), person };
}

function upsertMemoryReceipt(groupId, receipt) {
  const group = memoryGroups.get(groupId);
  if (!group) return notFound();
  const index = group.receipts.findIndex((item) => item.id === receipt.id);
  if (index >= 0) group.receipts[index] = receipt;
  else group.receipts.unshift(receipt);
  group.updatedAt = new Date().toISOString();
  return { group: publicGroup(group), receipt };
}

function notFound() {
  const error = new Error("Group not found.");
  error.statusCode = 404;
  throw error;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function roundCents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  addPerson,
  closeGroup,
  createGroup,
  deleteAccount,
  deleteTrip,
  getRequiredGroup,
  listAccounts,
  listTrips,
  publicGroup,
  reopenGroup,
  removePerson,
  resetTrip,
  restoreTrip,
  signInAccount,
  updateAccount,
  upsertReceipt,
};
