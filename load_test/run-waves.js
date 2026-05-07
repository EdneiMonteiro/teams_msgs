/**
 * Wave Load Test — roda testes sequenciais com volumes crescentes
 * e coleta resultados para comparação.
 * 
 * Uso: STORAGE_CONNECTION=xxx BOT_URL=xxx node load_test/run-waves.js
 */

const BASE_URL = process.env.BOT_URL || "http://localhost:3978";
const STORAGE_CONNECTION = process.env.STORAGE_CONNECTION || "";
const WAVES = [500, 1000, 10000, 15000];
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 1800000; // 30 min per wave

const { TableClient } = require("@azure/data-tables");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function seedRefs(count) {
  const table = TableClient.fromConnectionString(STORAGE_CONNECTION, "conversationrefs");
  try { await table.createTable(); } catch {}

  const realRefs = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const e of iter) {
    if (!e.rowKey.startsWith("fake-")) realRefs.push(e);
  }
  if (realRefs.length === 0) { console.error("❌ No real refs"); process.exit(1); }

  let created = 0;
  const start = Date.now();
  for (let i = 0; i < count; i += 50) {
    const promises = [];
    for (let j = i; j < Math.min(i + 50, count); j++) {
      const base = realRefs[j % realRefs.length];
      const fakeId = `fake-${j}-${Date.now()}`;
      const fakeRef = JSON.parse(base.refJson);
      fakeRef.conversation = { ...fakeRef.conversation, id: fakeId };
      promises.push(table.upsertEntity({ partitionKey: "refs", rowKey: fakeId, refJson: JSON.stringify(fakeRef) }, "Replace"));
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
  for await (const e of iter) { if (e.rowKey.startsWith("fake-")) fakes.push(e.rowKey); }
  let d = 0;
  for (let i = 0; i < fakes.length; i += 50) {
    await Promise.all(fakes.slice(i, i + 50).map((k) => table.deleteEntity("refs", k).catch(() => {})));
    d += Math.min(50, fakes.length - i);
    if (d % 2000 === 0 || d === fakes.length) process.stdout.write(`\r  Cleanup: ${d}/${fakes.length}`);
  }
  if (fakes.length > 0) console.log("");
  return fakes.length;
}

async function runWave(targetRefs) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  WAVE: ${targetRefs} refs`);
  console.log(`${"=".repeat(50)}`);

  // Seed
  console.log(`\n🌱 Seeding ${targetRefs} fake refs...`);
  const seedStart = Date.now();
  await seedRefs(targetRefs);
  const seedTime = Date.now() - seedStart;

  // Check count
  const statusResp = await fetch(`${BASE_URL}/api/status`);
  const status = await statusResp.json();
  const totalRefs = status.registeredUsers;
  console.log(`📋 Total refs: ${totalRefs}`);

  // Send
  console.log(`🚀 Sending...`);
  const sendStart = Date.now();
  const sendResp = await fetch(`${BASE_URL}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Wave ${targetRefs} — ${new Date().toISOString()}` }),
  });
  const sendResult = await sendResp.json();
  const enqueueTime = Date.now() - sendStart;
  console.log(`📬 Enqueued ${sendResult.total} msgs in ${(enqueueTime / 1000).toFixed(1)}s`);

  // Poll
  const pollStart = Date.now();
  let result = null;
  while (Date.now() - pollStart < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const job = await (await fetch(`${BASE_URL}/api/jobs/${sendResult.jobId}`)).json();
      const processed = (job.sent || 0) + (job.failed || 0);
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
      const rate = processed > 0 ? ((processed / (Date.now() - pollStart)) * 60000).toFixed(0) : "0";
      process.stdout.write(`\r  ${job.progress}% | ${processed}/${job.total} | Rate: ${rate} msg/min | ${elapsed}s   `);

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

  // Cleanup
  console.log(`🧹 Cleaning up...`);
  await cleanupFakeRefs();

  // Wait for KEDA cooldown to avoid interference between waves
  console.log(`⏳ Cooldown 30s...`);
  await sleep(30000);

  return result;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     WAVE LOAD TEST — Redis + Table Storage      ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  URL:    ${BASE_URL.substring(0, 40).padEnd(40)}║`);
  console.log(`║  Waves:  ${WAVES.join(", ").padEnd(40)}║`);
  console.log("╚══════════════════════════════════════════════════╝");

  const results = [];

  for (const wave of WAVES) {
    const result = await runWave(wave);
    if (result) results.push(result);
  }

  // Summary table
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

  // Save
  const fs = require("fs");
  fs.writeFileSync(__dirname + "/report-waves.json", JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  console.log("\n📄 Relatório salvo em load_test/report-waves.json\n");
}

main().catch(console.error);
