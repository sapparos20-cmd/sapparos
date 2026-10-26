const admin = require("firebase-admin");

function bangkokDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

function subtractCalendarMonths(dateString, months) {
  const [year, month, day] = dateString.split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(
    firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0
  )).getUTCDate();
  const finalDay = Math.min(day, lastDay);
  return `${firstOfTarget.getUTCFullYear()}-${String(firstOfTarget.getUTCMonth()+1).padStart(2,"0")}-${String(finalDay).padStart(2,"0")}`;
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT GitHub Actions secret.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();
  const today = bangkokDateString();
  const cutoff = subtractCalendarMonths(today, 2);

  // Read real Firestore documents. Only receive/issue records with a date strictly
  // earlier than the two-month cutoff are eligible for deletion.
  const snapshot = await db.collection("docs").get();
  const oldDocs = snapshot.docs.filter(doc => {
    const d = doc.data();
    return (d.type === "in" || d.type === "out") &&
      typeof d.date === "string" && d.date < cutoff;
  });

  if (oldDocs.length === 0) {
    console.log(`No old receive/issue documents to delete. Cutoff: ${cutoff}`);
    return;
  }

  // Aggregate the net quantity of eligible old records separately by branch + product.
  // Missing branch follows the existing app convention: "main".
  const totals = new Map();
  for (const doc of oldDocs) {
    const d = doc.data();
    const branch = d.branch || "main";
    for (const line of (Array.isArray(d.lines) ? d.lines : [])) {
      if (!line || !line.pid) {
        throw new Error(`Unsafe cleanup: document ${doc.id} has a line without pid. No data was changed.`);
      }
      const key = `${branch}|${line.pid}`;
      const current = totals.get(key) || {
        branch, pid: line.pid, name: line.name || line.pid,
        unit: line.unit || "", qty: 0
      };
      const quantity = Number(line.qty || 0);
      if (!Number.isFinite(quantity)) {
        throw new Error(`Unsafe cleanup: invalid quantity in document ${doc.id}. No data was changed.`);
      }
      current.qty = Math.round((current.qty + (d.type === "out" ? -1 : 1) * quantity) * 1000) / 1000;
      totals.set(key, current);
    }
  }

  const carries = [...totals.values()].filter(x => Math.abs(x.qty) > 0.0005);
  // Keep this operation atomic and under Firestore's 500-write batch limit.
  // If too large, stop without deleting anything; an operator can safely review it.
  if (oldDocs.length + carries.length > 450) {
    throw new Error(
      `Safety stop: ${oldDocs.length} old documents + ${carries.length} balance carries exceeds 450 writes. ` +
      "No changes were made. Reduce the backlog or run a reviewed migration."
    );
  }

  const now = new Date();
  const ts = now.toISOString();
  const batch = db.batch();

  for (const item of carries) {
    // Stable ID makes retries safe if a batch result is uncertain for this cutoff.
    const safeBranch = Buffer.from(item.branch).toString("base64url").slice(0, 24);
    const safePid = Buffer.from(item.pid).toString("base64url").slice(0, 32);
    const carryId = `AUTO-CARRY-${cutoff}-${safeBranch}-${safePid}`;
    const ref = db.collection("docs").doc(carryId);
    batch.set(ref, {
      type: "carry",
      branch: item.branch,
      no: carryId,
      date: cutoff,
      ts,
      note: "ยอดคงเหลือสะสมจากประวัติเก่าที่ลบอัตโนมัติ",
      by: "ระบบ",
      lines: [{
        pid: item.pid, name: item.name, unit: item.unit,
        qty: Math.abs(item.qty), sign: item.qty < 0 ? -1 : 1
      }]
    });
  }
  for (const doc of oldDocs) batch.delete(doc.ref);

  await batch.commit();
  console.log(`Cleanup complete. Cutoff: ${cutoff}; deleted: ${oldDocs.length}; balance carries: ${carries.length}.`);
}

main().catch(err => {
  console.error("Cleanup failed safely:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
