import { parentPort } from "node:worker_threads";
import { extractIfcModel } from "./ifc-model";

// Isolate synchronous WASM parsing from request handling. The parent enforces a deadline.
parentPort!.once("message", async (bytes: Uint8Array) => {
  try { parentPort!.postMessage({ result: await extractIfcModel(bytes) }); }
  catch { parentPort!.postMessage({ error: "IFC parsing failed or schema is unsupported" }); }
});
