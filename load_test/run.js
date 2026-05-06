// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
/**
 * Load Test: Simula 100 envios de mensagem via POST /api/send
 * 
 * Como só temos 1 usuário registrado, cada chamada envia para esse 1 usuário.
 * O teste mede latência, throughput e taxa de erro sob carga.
 * 
 * Uso:
 *   node load_test/run.js
 *   node load_test/run.js --requests 200 --concurrency 20
 */

const BASE_URL =
  process.env.BOT_URL || "http://localhost:3978";

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : defaultVal;
}

const TOTAL_REQUESTS = getArg("requests", 100);
const CONCURRENCY = getArg("concurrency", 10);
const DELAY_BETWEEN_BATCHES_MS = getArg("delay", 500);

async function sendOne(id) {
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `📊 Load test #${id} — ${new Date().toISOString()}`,
      }),
    });
    const data = await resp.json();
    const elapsed = Date.now() - start;
    return {
      id,
      status: resp.status,
      success: data.success || 0,
      failed: data.failed || 0,
      elapsed,
      error: null,
    };
  } catch (err) {
    return {
      id,
      status: 0,
      success: 0,
      failed: 1,
      elapsed: Date.now() - start,
      error: err.message,
    };
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  LOAD TEST — Teams Proactive Messaging Bot");
  console.log("=".repeat(60));
  console.log(`  URL:          ${BASE_URL}`);
  console.log(`  Requests:     ${TOTAL_REQUESTS}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Batch delay:  ${DELAY_BETWEEN_BATCHES_MS}ms`);
  console.log("=".repeat(60));

  // Verificar status
  const statusResp = await fetch(`${BASE_URL}/api/status`);
  const statusData = await statusResp.json();
  console.log(`\n📋 Usuários registrados: ${statusData.registeredUsers}`);
  console.log(`🚀 Iniciando ${TOTAL_REQUESTS} requests...\n`);

  const allResults = [];
  const ids = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i + 1);
  const batches = chunkArray(ids, CONCURRENCY);
  const globalStart = Date.now();

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchResults = await Promise.all(batch.map((id) => sendOne(id)));
    allResults.push(...batchResults);

    const done = allResults.length;
    const errors = allResults.filter((r) => r.error || r.failed > 0).length;
    const avgMs = Math.round(
      allResults.reduce((s, r) => s + r.elapsed, 0) / done
    );
    process.stdout.write(
      `\r  ✅ ${done}/${TOTAL_REQUESTS} | Erros: ${errors} | Avg: ${avgMs}ms`
    );

    if (b < batches.length - 1) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  const totalTime = Date.now() - globalStart;
  const latencies = allResults.map((r) => r.elapsed);
  const successCount = allResults.filter(
    (r) => !r.error && r.failed === 0
  ).length;
  const errorCount = TOTAL_REQUESTS - successCount;
  const errorDetails = allResults
    .filter((r) => r.error || r.failed > 0)
    .slice(0, 10);

  console.log("\n\n" + "=".repeat(60));
  console.log("  RESULTADO");
  console.log("=".repeat(60));
  console.log(`  Total requests:    ${TOTAL_REQUESTS}`);
  console.log(`  Sucesso:           ${successCount}`);
  console.log(`  Falhas:            ${errorCount}`);
  console.log(`  Tempo total:       ${(totalTime / 1000).toFixed(1)}s`);
  console.log(
    `  Throughput:        ${((TOTAL_REQUESTS / totalTime) * 1000).toFixed(1)} req/s`
  );
  console.log("  ---");
  console.log(`  Latência min:      ${Math.min(...latencies)}ms`);
  console.log(`  Latência avg:      ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`);
  console.log(`  Latência p50:      ${percentile(latencies, 50)}ms`);
  console.log(`  Latência p90:      ${percentile(latencies, 90)}ms`);
  console.log(`  Latência p99:      ${percentile(latencies, 99)}ms`);
  console.log(`  Latência max:      ${Math.max(...latencies)}ms`);
  console.log("=".repeat(60));

  if (errorDetails.length > 0) {
    console.log("\n  Primeiros erros:");
    for (const e of errorDetails) {
      console.log(`    #${e.id}: ${e.error || "failed=" + e.failed} (${e.elapsed}ms)`);
    }
  }

  // Salvar resultado em JSON
  const report = {
    timestamp: new Date().toISOString(),
    config: { totalRequests: TOTAL_REQUESTS, concurrency: CONCURRENCY, delayMs: DELAY_BETWEEN_BATCHES_MS },
    results: {
      success: successCount,
      failed: errorCount,
      totalTimeMs: totalTime,
      throughputReqPerSec: parseFloat(((TOTAL_REQUESTS / totalTime) * 1000).toFixed(2)),
      latency: {
        min: Math.min(...latencies),
        avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p99: percentile(latencies, 99),
        max: Math.max(...latencies),
      },
    },
    errors: errorDetails,
  };

  const fs = require("fs");
  const reportPath = __dirname + "/report.json";
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Relatório salvo em: ${reportPath}\n`);
}

main().catch(console.error);
