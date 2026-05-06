// Copyright (c) 2026 Ednei Monteiro. Licensed under the MIT License.
// See LICENSE and DISCLAIMER.md in the project root for details.
import { startWorker } from "./worker";

startWorker().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
