import { parentPort } from "node:worker_threads";
import { extractIfcBuildingModel } from "./ifc-building-model";

parentPort!.once("message", async (bytes: Uint8Array) => {
  try { parentPort!.postMessage({ result: await extractIfcBuildingModel(bytes) }); }
  catch { parentPort!.postMessage({ error: "IFC geometry could not be read. Use a valid IFC2X3 or IFC4 model with building/storey assignments." }); }
});
