import { startWorker } from "./worker";

startWorker().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
