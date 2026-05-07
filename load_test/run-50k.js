/**
 * Load Test 50K — Simula envio para N usuários com 1 único job.
 * 
 * 1. Seed N fake refs no Table Storage
 * 2. POST /api/send (1 único job → N mensagens enfileiradas)
 * 3. Poll progresso até completar
 * 4. Cleanup fake refs
 * 
 * Uso:
 *   node load_test/run-50k.js --refs 50000
 *   node load_test/run-50k.js --refs 10000 --skip-seed   (se refs já existem)
 *   node load_test/run-50k.js --cleanup                  (remove fake refs)
 */

const BASE_URL = process.env.BOT_URL || "http://localhost:3978";
const STORAGE_CONNECTION = process.env.STORAGE_CONNECTION || "";
const POLL_INTERVAL_MS = 5000;
const TIMEOUT_MS = 3600000; // 1h

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : defaultVal;
}
const hasFlag = (name) => args.includes(`--${name}`);

const TARGET_REFS = getArg("refs", 50000);
const SKIP_SEED = hasFlag("skip-seed");
const CLEANUP_ONLY = hasFlag("cleanup");

async function seedRefs(count) {
  console.log(`\n🌱 Seeding ${count} fake refs no Table Storage...\n`);

  const { TableClient } = require("@azure/data-tables");
  const table = TableClient.fromConnectionString(STORAGE_CONNECTION, "conversationrefs");
  try { await table.createTable(); } catch {}

  // Get real refs to clone
  const realRefs = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const entity of iter) {
    if (!entity.rowKey.startsWith("fake-")) {
      realRefs.push(entity);
    }
  }

  if (realRefs.length === 0) {
    console.error("❌ Nenhuma ref real encontrada. Instale o Teams app primeiro.");
    process.exit(1);
  }

  console.log(`  Refs reais encontradas: ${realRefs.length}`);

  const BATCH = 50;
  let created = 0;
  const start = Date.now();

  for (let i = 0; i < count; i += BATCH) {
    const promises = [];
    for (let j = i; j < Math.min(i + BATCH, count); j++) {
      const base = realRefs[j % realRefs.length];
      const fakeId = `fake-${j}-${Date.now()}`;
      const fakeRef = JSON.parse(base.refJson);
      fakeRef.conversation = { ...fakeRef.conversation, id: fakeId };

      promises.push(
        table.upsertEntity({
          partitionKey: "refs",
          rowKey: fakeId,
          refJson: JSON.stringify(fakeRef),
        }, "Replace")
      );
    }
    await Promise.all(promises);
    created += promises.length;

    if (created % 1000 === 0 || created === count) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const rate = (created / ((Date.now() - start) / 1000)).toFixed(0);
      process.stdout.write(`\r  ✅ ${created}/${count} refs seeded (${rate}/s, ${elapsed}s)`);
    }
  }
  console.log("\n");
  return created;
}

async function cleanupRefs() {
  console.log("\n🧹 Cleaning up fake refs...\n");

  const { TableClient } = require("@azure/data-tables");
  const table = TableClient.fromConnectionString(STORAGE_CONNECTION, "conversationrefs");

  const fakeRefs = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const entity of iter) {
    if (entity.rowKey.startsWith("fake-")) {
      fakeRefs.push(entity);
    }
  }

  console.log(`  Found ${fakeRefs.length} fake refs to delete`);

  const BATCH = 50;
  let deleted = 0;
  for (let i = 0; i < fakeRefs.length; i += BATCH) {
    const promises = fakeRefs.slice(i, i + BATCH).map((r) =>
      table.deleteEntity("refs", r.rowKey).catch(() => {})
    );
    await Promise.all(promises);
    deleted += promises.length;
    if (deleted % 1000 === 0 || deleted === fakeRefs.length) {
      process.stdout.write(`\r  🗑️ ${deleted}/${resources.length} deleted`);
    }
  }
  console.log("\n\nDone.\n");
  return deleted;
}

async function pollJob(jobId) {
  const resp = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
  return await resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (CLEANUP_ONLY) {
    await cleanupRefs();
    return;
  }

  console.log("=".repeat(60));
  console.log("  LOAD TEST 50K — Single Job, Simulated Users");
  console.log("=".repeat(60));
  console.log(`  URL:        ${BASE_URL}`);
  console.log(`  Target:     ${TARGET_REFS} refs`);
  console.log(`  Skip seed:  ${SKIP_SEED}`);
  console.log("=".repeat(60));

  // Step 1: Seed fake refs
  if (!SKIP_SEED) {
    await seedRefs(TARGET_REFS);
  }

  // Step 2: Check ref count
  const statusResp = await fetch(`${BASE_URL}/api/status`);
  const status = await statusResp.json();
  console.log(`📋 Refs registradas: ${status.registeredUsers}`);

  // Step 3: Send 1 job
  console.log(`\n🚀 Enviando 1 job para ${status.registeredUsers} usuários...\n`);
  const sendStart = Date.now();

  const sendResp = await fetch(`${BASE_URL}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `📊 Load test 50K — ${new Date().toISOString()}` }),
  });
  const sendResult = await sendResp.json();
  const enqueueTime = Date.now() - sendStart;

  console.log(`📬 Job criado: ${sendResult.jobId}`);
  console.log(`   Total: ${sendResult.total} mensagens`);
  console.log(`   Enqueue time: ${(enqueueTime / 1000).toFixed(1)}s`);
  console.log(`\n⏳ Aguardando processamento...\n`);

  // Step 4: Poll progress
  const pollStart = Date.now();
  let lastProgress = -1;
  let completed = false;

  while (!completed && Date.now() - pollStart < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const job = await pollJob(sendResult.jobId);
      const progress = job.progress || 0;
      const processed = (job.sent || 0) + (job.failed || 0);
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
      const rate = processed > 0 ? ((processed / (Date.now() - pollStart)) * 60000).toFixed(0) : "0";

      if (progress !== lastProgress) {
        process.stdout.write(
          `\r  ${progress}% | ${processed}/${job.total} | Sent: ${job.sent} | Failed: ${job.failed} | Rate: ${rate} msg/min | ${elapsed}s`
        );
        lastProgress = progress;
      }

      if (job.status === "completed") {
        completed = true;
        const totalTime = Date.now() - sendStart;
        const processingTime = Date.now() - pollStart;

        console.log("\n\n" + "=".repeat(60));
        console.log("  RESULTADO");
        console.log("=".repeat(60));
        console.log(`  Total refs:        ${job.total}`);
        console.log(`  Enviadas:          ${job.sent}`);
        console.log(`  Falhas:            ${job.failed}`);
        console.log(`  Enqueue time:      ${(enqueueTime / 1000).toFixed(1)}s`);
        console.log(`  Processing time:   ${(processingTime / 1000).toFixed(1)}s`);
        console.log(`  Total time:        ${(totalTime / 1000).toFixed(1)}s`);
        console.log(`  Throughput:        ${((processed / processingTime) * 60000).toFixed(0)} msg/min`);
        console.log("=".repeat(60));

        if (job.errors?.length > 0) {
          const uniqueErrors = [...new Set(job.errors)];
          console.log(`\n  Erros únicos (${uniqueErrors.length}):`);
          uniqueErrors.slice(0, 5).forEach((e) => console.log(`    - ${e}`));
        }

        // Save report
        const fs = require("fs");
        const report = {
          timestamp: new Date().toISOString(),
          architecture: "ACA + KEDA + Service Bus + Redis + Table Storage",
          config: { targetRefs: TARGET_REFS, actualRefs: job.total },
          results: {
            sent: job.sent,
            failed: job.failed,
            enqueueTimeMs: enqueueTime,
            processingTimeMs: processingTime,
            totalTimeMs: totalTime,
            throughputMsgPerMin: parseFloat(((processed / processingTime) * 60000).toFixed(2)),
          },
        };
        fs.writeFileSync(__dirname + "/report-50k.json", JSON.stringify(report, null, 2));
        console.log(`\n📄 Relatório salvo em load_test/report-50k.json`);

        // Step 5: Cleanup
        console.log("");
        await cleanupRefs();
        return;
      }
    } catch (err) {
      // API might be slow under load
    }
  }

  console.log("\n❌ Timeout! Job não completou em 1 hora.");
  await cleanupRefs();
}

main().catch(console.error);
