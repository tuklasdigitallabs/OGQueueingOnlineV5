// seed-demo-today.js
// Seeds realistic queue_items for month-to-date (Manila) to support:
// - Daily Summary + EMA14 testing
// - Month-to-date report testing
// Also seeds realistic "called more than once" data via next_calls.

const { randomUUID } = require("crypto");
const { openDb } = require("./db");

function getTodayManila() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const manila = new Date(utcMs + 8 * 60 * 60000);
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, "0");
  const d = String(manila.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthStartYmd(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return ymd;
  return `${m[1]}-${m[2]}-01`;
}

function ymdToUtcDate(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
}

function ymdAddDays(ymd, delta) {
  const d = ymdToUtcDate(ymd);
  if (!d) return ymd;
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function ymdRangeInclusive(fromYmd, toYmd) {
  const out = [];
  let cur = fromYmd;
  while (cur <= toYmd) {
    out.push(cur);
    cur = ymdAddDays(cur, 1);
  }
  return out;
}

function manilaEpochForYmd(ymd, h, min = 0, sec = 0) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return Date.now();
  const Y = Number(m[1]);
  const M = Number(m[2]);
  const D = Number(m[3]);
  // Manila is UTC+8 -> UTC = Manila - 8h
  return Date.UTC(Y, M - 1, D, h - 8, min, sec, 0);
}

function pickWeighted(items) {
  const total = items.reduce((a, b) => a + b.w, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function computeGroupCodeFromPax(pax) {
  const n = Number(pax || 1);
  if (n <= 1) return "A";
  if (n <= 3) return "B";
  if (n <= 5) return "C";
  return "D";
}

function minutes(n) {
  return n * 60_000;
}

function expRand(mean) {
  return -Math.log(1 - Math.random()) * mean;
}

function ticketsPerHourAt(tMs, t10, t15, dayFactor) {
  const t11 = t10 + minutes(60);
  const t13 = t10 + minutes(180);
  const t14 = t10 + minutes(240);

  let base = 12;
  if (tMs < t11) base = 10;
  else if (tMs < t13) base = 26;
  else if (tMs < t14) base = 16;
  else if (tMs <= t15) base = 12;

  return Math.max(4, Math.round(base * dayFactor));
}

function ymdWeekday(ymd) {
  const d = ymdToUtcDate(ymd);
  return d ? d.getUTCDay() : 1; // 0 Sun ... 6 Sat
}

function dayLoadFactor(ymd) {
  const w = ymdWeekday(ymd);
  if (w === 0) return 0.72; // Sun
  if (w === 6) return 0.84; // Sat
  if (w === 5) return 1.10; // Fri
  return 1.0 + ((Math.random() - 0.5) * 0.12); // weekday jitter
}

function fmtManilaHms(ms) {
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function main() {
  const baseDir = process.argv[2] || process.cwd();
  const db = openDb(baseDir);

  let bc = "DEV";
  try {
    const row = db.prepare(`SELECT branchCode FROM branch_config WHERE id=1`).get();
    if (row && row.branchCode) bc = String(row.branchCode).trim() || bc;
  } catch {}

  const today = getTodayManila();
  const fromYmd = monthStartYmd(today);
  const days = ymdRangeInclusive(fromYmd, today);
  const now = Date.now();

  // Wipe existing branch data for the seeded date range
  db.prepare(`DELETE FROM queue_items WHERE branchCode=? AND businessDate BETWEEN ? AND ?`).run(bc, fromYmd, today);
  db.prepare(`DELETE FROM daily_group_stats WHERE branchCode=? AND businessDate BETWEEN ? AND ?`).run(bc, fromYmd, today);

  const insTicket = db.prepare(`
    INSERT INTO queue_items
      (id, branchCode, businessDate, groupCode, queueNum,
       name, pax, status, priorityType, createdAtLocal, calledAt, next_calls, seatedAt, skippedAt)
    VALUES
      (?,  ?,          ?,           ?,        ?,
       ?,    ?,   ?,      ?,          ?,             ?,       ?,         ?,       ?)
  `);

  const insDaily = db.prepare(`
    INSERT INTO daily_group_stats
      (businessDate, branchCode, groupCode,
       registeredCount, calledCount, seatedCount, skippedCount, overrideCalledCount,
       waitSumMinutes, waitCount, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const first = ["Ana","Ben","Carlo","Dana","Eli","Faye","Gio","Hana","Ian","Jai","Kara","Lia","Miko","Noah","Omar","Pia","Quin","Ria","Sam","Tina","Uma","Vince","Wen","Xian","Yuri","Zoe"];
  const last = ["Santos","Reyes","Cruz","Garcia","Flores","Ramos","Mendoza","Torres","Villanueva","Gonzales","Bautista","Navarro","Lim","Tan","Sy","Chan","Lee","Chua","Yu"];

  function fakeName() {
    return `${first[(Math.random() * first.length) | 0]} ${last[(Math.random() * last.length) | 0]}`;
  }

  function pickPax() {
    return pickWeighted([
      { v: 1, w: 35 },
      { v: 2, w: 25 },
      { v: 3, w: 20 },
      { v: 4, w: 10 },
      { v: 5, w: 5 },
      { v: 6, w: 3 },
      { v: 7, w: 2 },
    ]);
  }

  function pickPriorityType(createdAt) {
    const hourManila = new Date(createdAt + 8 * 3600_000).getUTCHours();
    const p = (hourManila >= 11 && hourManila <= 13) ? 0.15 : 0.11;
    if (Math.random() > p) return "NONE";
    return Math.random() < 0.7 ? "SENIOR" : "PWD";
  }

  function sampleWaitMinutes(groupCode, priorityType) {
    const base = { A: 12, B: 14, C: 18, D: 24 }[groupCode] || 14;
    const noise = (Math.random() - 0.5) * 10;
    const prBoost = (priorityType !== "NONE") ? -4 : 0;
    return clamp(base + noise + prBoost, 3, 50);
  }

  function sampleExtraCalls(status, groupCode, priorityType) {
    if (status !== "SEATED" && status !== "SKIPPED") return 0;
    // realistic: many single-calls, meaningful share with multiple recalls
    const base = pickWeighted([
      { v: 0, w: 53 },
      { v: 1, w: 29 },
      { v: 2, w: 13 },
      { v: 3, w: 5 },
    ]);
    const groupAdj = groupCode === "D" ? (Math.random() < 0.22 ? 1 : 0) : 0;
    const prAdj = priorityType !== "NONE" ? (Math.random() < 0.10 ? -1 : 0) : 0;
    return clamp(base + groupAdj + prAdj, 0, 4);
  }

  let grandInserted = 0;
  const perDayOut = [];

  for (const ymd of days) {
    const t10 = manilaEpochForYmd(ymd, 10, 0, 0);
    const t15 = manilaEpochForYmd(ymd, 15, 0, 0);
    const factor = dayLoadFactor(ymd);

    // Generate arrivals for this business date
    const arrivals = [];
    let t = t10;
    while (t < t15) {
      const ratePerHour = ticketsPerHourAt(t, t10, t15, factor);
      const meanMinutesBetween = 60 / Math.max(ratePerHour, 1);
      const dtMin = expRand(meanMinutesBetween);
      t += minutes(dtMin);
      if (t < t15) arrivals.push(Math.floor(t));
    }

    const counters = {
      A: { reg: 0, pr: 0 },
      B: { reg: 0, pr: 0 },
      C: { reg: 0, pr: 0 },
      D: { reg: 0, pr: 0 },
    };

    const isToday = ymd === today;
    const dayStats = {
      A: { reg: 0, call: 0, seat: 0, skip: 0, waitSum: 0, waitN: 0 },
      B: { reg: 0, call: 0, seat: 0, skip: 0, waitSum: 0, waitN: 0 },
      C: { reg: 0, call: 0, seat: 0, skip: 0, waitSum: 0, waitN: 0 },
      D: { reg: 0, call: 0, seat: 0, skip: 0, waitSum: 0, waitN: 0 },
    };

    let seatedCount = 0;
    let waitingCount = 0;
    let skippedCount = 0;

    for (const createdAtLocal of arrivals) {
      const pax = pickPax();
      const groupCode = computeGroupCodeFromPax(pax);
      const priorityType = pickPriorityType(createdAtLocal);
      const isPriority = priorityType !== "NONE";

      const bucket = isPriority ? "pr" : "reg";
      counters[groupCode][bucket] += 1;
      const queueNum = counters[groupCode][bucket];

      const waitMins = sampleWaitMinutes(groupCode, priorityType);
      const calledAt = Math.floor(createdAtLocal + minutes(waitMins * 0.72));
      const seatedAt = Math.floor(createdAtLocal + minutes(waitMins));

      let status = "SEATED";
      if (isToday) {
        if (seatedAt > (t15 - minutes(5))) {
          status = Math.random() < 0.18 ? "SKIPPED" : "WAITING";
        } else {
          const roll = Math.random();
          if (roll < 0.10) status = "SKIPPED";
          else if (roll < 0.17) status = "WAITING";
          else status = "SEATED";
        }
      } else {
        status = Math.random() < 0.11 ? "SKIPPED" : "SEATED";
      }

      const firstCalledAt = (status === "SEATED" || status === "SKIPPED") ? calledAt : null;
      const extraCalls = sampleExtraCalls(status, groupCode, priorityType);
      const nextCallTimes = [];
      if (firstCalledAt) {
        let prevAt = firstCalledAt;
        for (let i = 0; i < extraCalls; i++) {
          const jitterMin = 1 + Math.floor(Math.random() * 6); // 1-6 mins between recalls
          const nxt = Math.floor(prevAt + minutes(jitterMin));
          nextCallTimes.push(fmtManilaHms(nxt + (8 * 3600_000)));
          prevAt = nxt;
        }
      }

      const id = randomUUID();
      insTicket.run(
        id,
        bc,
        ymd,
        groupCode,
        queueNum,
        fakeName(),
        pax,
        status,
        priorityType,
        createdAtLocal,
        firstCalledAt,
        nextCallTimes.join(","),
        status === "SEATED" ? seatedAt : null,
        status === "SKIPPED" ? Math.floor(calledAt + minutes(Math.max(1, waitMins * 0.22))) : null
      );

      const s = dayStats[groupCode];
      s.reg += 1;
      if (firstCalledAt) s.call += 1;
      if (status === "SEATED") {
        s.seat += 1;
        if (Number.isFinite(seatedAt) && Number.isFinite(createdAtLocal) && seatedAt >= createdAtLocal) {
          s.waitSum += (seatedAt - createdAtLocal) / 60000.0; // created -> seated minutes
          s.waitN += 1;
        }
      }
      if (status === "SKIPPED") s.skip += 1;

      if (status === "SEATED") seatedCount++;
      else if (status === "SKIPPED") skippedCount++;
      else waitingCount++;
    }

    for (const g of ["A", "B", "C", "D"]) {
      const s = dayStats[g];
      if (!s.reg) continue;
      insDaily.run(
        ymd,
        bc,
        g,
        s.reg,
        s.call,
        s.seat,
        s.skip,
        0,
        s.waitSum,
        s.waitN,
        now,
        now
      );
    }

    grandInserted += arrivals.length;
    perDayOut.push(`${ymd}: ${arrivals.length} (SEATED=${seatedCount}, WAITING=${waitingCount}, SKIPPED=${skippedCount})`);
  }

  console.log(`[Seed] Done for ${fromYmd}..${today} branch=${bc}`);
  console.log(`[Seed] Inserted total: ${grandInserted} ticket rows across ${days.length} day(s).`);
  for (const line of perDayOut.slice(-10)) console.log(`[Seed] ${line}`);
  console.log(`[Seed] Daily rollups refreshed in daily_group_stats for seeded dates.`);

  try { db.close(); } catch {}
}

main();
process.exit(0);
