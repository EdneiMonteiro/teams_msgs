// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
/**
 * Load Test para arquitetura assíncrona (Service Bus + ACA Worker)
 * 
 * Envia N jobs e monitora progresso até completar.
 * 
 * Uso:
 *   node load_test/run-async.js
 *   node load_test/run-async.js --jobs 10
 */

const BASE_URL =
  process.env.BOT_URL || "http://localhost:3978";

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : defaultVal;
}

const TOTAL_JOBS = getArg("jobs", 100);
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 600000; // 10 min

async function sendJob(id) {
  const resp = await fetch(`${BASE_URL}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `📊 Async load test #${id} — ${new Date().toISOString()}`,
    }),
  });
  return await resp.json();
}

async function pollJob(jobId) {
  const resp = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
  return await resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ASYNC LOAD TEST — ACA + KEDA + Service Bus");
  console.log("=".repeat(60));
  console.log(`  URL:       ${BASE_URL}`);
  console.log(`  Jobs:      ${TOTAL_JOBS}`);
  console.log("=".repeat(60));

  // Status
  const statusResp = await fetch(`${BASE_URL}/api/status`);
  const status = await statusResp.json();
  console.log(`\n📋 Usuários registrados: ${status.registeredUsers}`);
  console.log(`📨 Mode: ${status.mode}\n`);

  // Enviar todos os jobs
  console.log(`🚀 Enviando ${TOTAL_JOBS} jobs...\n`);
  const startTime = Date.now();
  const jobs = [];

  for (let i = 1; i <= TOTAL_JOBS; i++) {
    const result = await sendJob(i);
    jobs.push({ id: i, jobId: result.jobId, total: result.total });
    if (i % 10 === 0) {
      process.stdout.write(`\r  Enfileirados: ${i}/${TOTAL_JOBS}`);
    }
  }

  const enqueueTime = Date.now() - startTime;
  const totalMessages = jobs.reduce((s, j) => s + j.total, 0);
  console.log(`\n\n📬 ${TOTAL_JOBS} jobs enfileirados em ${(enqueueTime / 1000).toFixed(1)}s`);
  console.log(`   Total mensagens: ${totalMessages}`);
  console.log(`\n⏳ Aguardando processamento...\n`);

  // Poll até todos completarem
  const pollStart = Date.now();
  let allDone = false;

  while (!allDone && Date.now() - pollStart < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    let completed = 0;
    let totalSent = 0;
    let totalFailed = 0;

    for (const job of jobs) {
      try {
        const status = await pollJob(job.jobId);
        if (status.status === "completed") completed++;
        totalSent += status.sent || 0;
        totalFailed += status.failed || 0;
      } catch {}
    }

    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
    const rate = totalSent > 0 ? ((totalSent / (Date.now() - pollStart)) * 60000).toFixed(0) : "0";
    process.stdout.write(
      `\r  Jobs: ${completed}/${TOTAL_JOBS} | Msgs: ${totalSent + totalFailed}/${totalMessages} | Rate: ${rate} msg/min | ${elapsed}s`
    );

    if (completed === TOTAL_JOBS) {
      allDone = true;
    }
  }

  const totalTime = Date.now() - startTime;

  // Resultados finais
  let totalSent = 0;
  let totalFailed = 0;
  const errors = [];

  for (const job of jobs) {
    try {
      const status = await pollJob(job.jobId);
      totalSent += status.sent || 0;
      totalFailed += status.failed || 0;
      if (status.errors?.length > 0) {
        errors.push(...status.errors.slice(0, 5));
      }
    } catch {}
  }

  console.log("\n\n" + "=".repeat(60));
  console.log("  RESULTADO");
  console.log("=".repeat(60));
  console.log(`  Total jobs:       ${TOTAL_JOBS}`);
  console.log(`  Total msgs:       ${totalMessages}`);
  console.log(`  Enviadas:         ${totalSent}`);
  console.log(`  Falhas:           ${totalFailed}`);
  console.log(`  Enqueue time:     ${(enqueueTime / 1000).toFixed(1)}s`);
  console.log(`  Processing time:  ${((totalTime - enqueueTime) / 1000).toFixed(1)}s`);
  console.log(`  Total time:       ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`  Throughput:       ${((totalSent / (totalTime - enqueueTime)) * 60000).toFixed(0)} msg/min`);
  console.log("=".repeat(60));

  if (errors.length > 0) {
    console.log("\n  Erros:");
    errors.slice(0, 10).forEach((e) => console.log(`    - ${e}`));
  }

  // Salvar
  const fs = require("fs");
  const report = {
    timestamp: new Date().toISOString(),
    architecture: "ACA + KEDA + Service Bus",
    config: { jobs: TOTAL_JOBS, totalMessages },
    results: {
      sent: totalSent,
      failed: totalFailed,
      enqueueTimeMs: enqueueTime,
      processingTimeMs: totalTime - enqueueTime,
      totalTimeMs: totalTime,
      throughputMsgPerMin: parseFloat(((totalSent / (totalTime - enqueueTime)) * 60000).toFixed(2)),
    },
    errors: errors.slice(0, 20),
  };
  fs.writeFileSync(__dirname + "/report-async.json", JSON.stringify(report, null, 2));
  console.log(`\n📄 Relatório salvo em load_test/report-async.json\n`);
}

main().catch(console.error);
