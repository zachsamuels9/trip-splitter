const crypto = require("crypto");

const memoryGroups = new Map();

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

async function getGroup(id) {
  if (!supabaseEnv()) return memoryGroups.get(id) || null;

  try {
    const tripFilter = isUuid(id) ? `id=eq.${encodeURIComponent(id)}` : `invite_code=eq.${encodeURIComponent(id)}`;
    const trips = await supabase(`trips?${tripFilter}&limit=1`);
    const trip = trips?.[0];
    if (!trip) return null;

    const [peopleRows, receiptRows] = await Promise.all([
      supabase(`participants?trip_id=eq.${trip.id}&order=created_at.asc`),
      supabase(`receipts?trip_id=eq.${trip.id}&order=created_at.desc`),
    ]);

    const receiptIds = receiptRows.map((receipt) => receipt.id);
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
      createdAt: person.created_at,
    }));
    const receipts = receiptRows.map((receipt) => receiptFromRows(receipt, lineItems, assignments, images, people));

    return publicGroup({
      id: trip.id,
      name: trip.name,
      people,
      receipts,
      closedAt: trip.closed_at || null,
      status: trip.status || (trip.closed_at ? "closed" : "active"),
      createdAt: trip.created_at,
      updatedAt: trip.updated_at,
    });
  } catch (error) {
    if (isSupabaseUnavailable(error)) return memoryGroups.get(id) || null;
    throw error;
  }
}

async function createGroup({ name, personName }) {
  if (!supabaseEnv()) return createMemoryGroup({ name, personName });

  try {
    const tripRows = await supabase("trips", {
      method: "POST",
      prefer: "return=representation",
      body: { name: cleanName(name, "Trip group", 80) },
    });
    const trip = tripRows[0];
    const person = createPerson(personName || "You");
    await supabase("participants", {
      method: "POST",
      prefer: "return=representation",
      body: { id: person.id, trip_id: trip.id, name: person.name },
    });

    const group = await getRequiredGroup(trip.id);
    return { group, person };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return createMemoryGroup({ name, personName });
    throw error;
  }
}

async function addPerson(groupId, name) {
  if (!supabaseEnv()) return addMemoryPerson(groupId, name);

  try {
    const group = await getRequiredGroup(groupId);
    const person = createPerson(name);
    await supabase("participants", {
      method: "POST",
      prefer: "return=representation",
      body: { id: person.id, trip_id: group.id, name: person.name },
    });
    return { group: await getRequiredGroup(group.id), person };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return addMemoryPerson(groupId, name);
    throw error;
  }
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

  try {
    const group = await getRequiredGroup(groupId);
    await supabase(`trips?id=eq.${group.id}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "closed", closed_at: new Date().toISOString() },
    });
    return { group: await getRequiredGroup(group.id) };
  } catch (error) {
    if (isSupabaseUnavailable(error)) return closeMemoryGroup(groupId);
    throw error;
  }
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
  if (claimed > 0) return (item.amount || 0) * (claimed / quantity);
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
    assignmentStatus: items.some((item) => !item.assignedTo.length) ? "pending" : "complete",
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
    const split = Number(item.amount || 0) / assignedTo.length;
    assignedTo.forEach((participantId) => {
      native[participantId] = (native[participantId] || 0) + split;
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
  return (receipt.items || []).some((item) => !(item.assignedTo || []).length);
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
  const group = {
    id: crypto.randomUUID(),
    name: cleanName(name, "Trip group", 80),
    people: [person],
    receipts: [],
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

function addMemoryPerson(groupId, name) {
  const group = memoryGroups.get(groupId);
  if (!group) return notFound();
  const person = createPerson(name);
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
  getRequiredGroup,
  publicGroup,
  upsertReceipt,
};
