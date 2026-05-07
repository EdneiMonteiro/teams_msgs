// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
//
// Wave Load Test — roda testes sequenciais com volumes crescentes para
// observar comportamento do KEDA (cold start, warm pool, throughput).
//
// Variáveis: BOT_URL, API_KEY, STORAGE_CONNECTION
// Uso:       node load_test/run-waves.js [--waves "500,1000,10000,15000"]

const BASE_URL = process.env.BOT_URL || "http://localhost:3978";
const API_KEY = process.env.API_KEY || "";
const STORAGE_CONNECTION = process.env.STORAGE_CONNECTION || "";

const wavesArg = (() => {
  const idx = process.argv.indexOf("--waves");
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const WAVES = wavesArg
  ? wavesArg.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  : [500, 1000, 10000, 15000];

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 min por wave
const COOLDOWN_MS = 30000;

const { TableClient } = require("@azure/data-tables");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

async function seedRefs(count) {
  const table = TableClient.fromConnectionString(STORAGE_CONNECTION, "conversationrefs");
  try { await table.createTable(); } catch {}

  const realRefs = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const e of iter) {
    if (!e.rowKey.startsWith("fake-")) realRefs.push(e);
  }
  if (realRefs.length === 0) {
    console.error("❌ Nenhuma ref real encontrada. Instale o Teams app primeiro.");
    process.exit(1);
  }

  let created = 0;
  const start = Date.now();
  for (let i = 0; i < count; i += 50) {
    const promises = [];
    for (let j = i; j < Math.min(i + 50, count); j++) {
      const base = realRefs[j % realRefs.length];
      const fakeId = `fake-${j}-${Date.now()}`;
      const fakeRef = JSON.parse(base.refJson);
      fakeRef.conversation = { ...fakeRef.conversation, id: fakeId };
      promises.push(
        table.upsertEntity(
          { partitionKey: "refs", rowKey: fakeId, refJson: JSON.stringify(fakeRef) },
          "Replace"
        )
      );
    }
    await Promise.all(promises);
    created += promises.length;
    if (created % 1000 === 0 || created === count) {
      const rate = (created / ((Date.now() - start) / 1000)).toFixed(0);
      process.stdout.write(`\r  Seed: ${created}/${count} (${rate}/s)`);
    }
  }
  console.log("");
  return created;
}

async function cleanupFakeRefs() {
  const table = TableClient.fromConnectionString(STORAGE_CONNECTION, "conversationrefs");
  const fakes = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const e of iter) {
    if (e.rowKey.startsWith("fake-")) fakes.push(e.rowKey);
  }
  let deleted = 0;
  const total = fakes.length;
  for (let i = 0; i < total; i += 50) {
    await Promise.all(
      fakes.slice(i, i + 50).map((k) => table.deleteEntity("refs", k).catch(() => {}))
    );
    deleted += Math.min(50, total - i);
    if (deleted % 2000 === 0 || deleted === total) {
      process.stdout.write(`\r  Cleanup: ${deleted}/${total}`);
    }
  }
  if (total > 0) console.log("");
  return total;
}

async function runWave(targetRefs) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  WAVE: ${targetRefs} refs`);
  console.log(`${"=".repeat(50)}`);

  console.log(`\n🌱 Seeding ${targetRefs} fake refs...`);
  await seedRefs(targetRefs);

  const statusResp = await fetch(`${BASE_URL}/api/status`, { headers: authHeaders() });
  const status = await statusResp.json();
  console.log(`📋 Total refs: ${status.registeredUsers}`);

  console.log(`🚀 Sending...`);
  const sendStart = Date.now();
  const sendResp = await fetch(`${BASE_URL}/api/send`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ message: `Wave ${targetRefs} — ${new Date().toISOString()}` }),
  });

  if (!sendResp.ok) {
    const txt = await sendResp.text();
    console.error(`❌ /api/send falhou: ${sendResp.status} ${txt}`);
    await cleanupFakeRefs();
    return null;
  }

  const sendResult = await sendResp.json();
  const enqueueTime = Date.now() - sendStart;
  console.log(`📬 Enqueued ${sendResult.total} msgs in ${(enqueueTime / 1000).toFixed(1)}s`);

  const pollStart = Date.now();
  let result = null;
  while (Date.now() - pollStart < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const job = await (await fetch(
        `${BASE_URL}/api/jobs/${sendResult.jobId}`,
        { headers: authHeaders() }
      )).json();
      const processed = (job.sent || 0) + (job.failed || 0);
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
      const rate = processed > 0
        ? ((processed / (Date.now() - pollStart)) * 60000).toFixed(0)
        : "0";
      process.stdout.write(
        `\r  ${job.progress}% | ${processed}/${job.total} | Rate: ${rate} msg/min | ${elapsed}s   `
      );

      if (job.status === "completed") {
        const processingTime = Date.now() - pollStart;
        result = {
          refs: targetRefs,
          totalMsgs: job.total,
          sent: job.sent,
          failed: job.failed,
          enqueueTimeSec: parseFloat((enqueueTime / 1000).toFixed(1)),
          processingTimeSec: parseFloat((processingTime / 1000).toFixed(1)),
          throughputMsgMin: parseFloat(((processed / processingTime) * 60000).toFixed(0)),
        };
        console.log(`\n✅ Completed: ${job.sent} sent, ${job.failed} failed, ${result.throughputMsgMin} msg/min`);
        break;
      }
    } catch {}
  }

  console.log(`🧹 Cleaning up...`);
  await cleanupFakeRefs();
  console.log(`⏳ Cooldown ${COOLDOWN_MS / 1000}s...`);
  await sleep(COOLDOWN_MS);
  return result;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     WAVE LOAD TEST — Redis + Table Storage      ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  URL:    ${BASE_URL.substring(0, 40).padEnd(40)}║`);
  console.log(`║  Waves:  ${WAVES.join(", ").padEnd(40)}║`);
  console.log(`║  Auth:   ${(API_KEY ? "x-api-key present" : "DISABLED (dev)").padEnd(40)}║`);
  console.log("╚══════════════════════════════════════════════════╝");

  const results = [];
  for (const wave of WAVES) {
    const r = await runWave(wave);
    if (r) results.push(r);
  }

  console.log("\n\n" + "═".repeat(80));
  console.log("  RESULTADO CONSOLIDADO");
  console.log("═".repeat(80));
  console.log("  Refs     │ Total Msgs │ Sent     │ Failed │ Enqueue  │ Process  │ Throughput");
  console.log("  ─────────┼────────────┼──────────┼────────┼──────────┼──────────┼───────────");
  for (const r of results) {
    console.log(
      `  ${String(r.refs).padStart(7)}  │ ${String(r.totalMsgs).padStart(10)} │ ${String(r.sent).padStart(8)} │ ${String(r.failed).padStart(6)} │ ${(r.enqueueTimeSec + "s").padStart(8)} │ ${(r.processingTimeSec + "s").padStart(8)} │ ${(r.throughputMsgMin + " msg/min").padStart(14)}`
    );
  }
  console.log("═".repeat(80));

  const fs = require("fs");
  fs.writeFileSync(
    __dirname + "/report-waves.json",
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log("\n📄 Relatório salvo em load_test/report-waves.json\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
