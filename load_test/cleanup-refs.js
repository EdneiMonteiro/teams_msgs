// Cleanup all fake refs from Table Storage
const { TableClient } = require("@azure/data-tables");

async function cleanup() {
  const table = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION, "conversationrefs");
  const fakes = [];
  const iter = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const e of iter) {
    if (e.rowKey.startsWith("fake-")) fakes.push(e.rowKey);
  }
  console.log("Fake refs found: " + fakes.length);
  let d = 0;
  for (let i = 0; i < fakes.length; i += 50) {
    const batch = fakes.slice(i, i + 50);
    await Promise.all(batch.map((k) => table.deleteEntity("refs", k).catch(() => {})));
    d += batch.length;
    if (d % 1000 === 0 || d === fakes.length) {
      process.stdout.write("\r  Deleted: " + d + "/" + fakes.length);
    }
  }
  console.log("\nDone.");

  let count = 0;
  const iter2 = table.listEntities({ queryOptions: { filter: "PartitionKey eq 'refs'" } });
  for await (const e of iter2) count++;
  console.log("Remaining refs: " + count);
}

cleanup().catch(console.error);
