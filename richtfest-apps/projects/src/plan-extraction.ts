import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import { extractPlanFootprints } from "./plan-footprints";
import { inferPlanTopology } from "./plan-topology";
import { outlineWallFootprints } from "./plan-outline-walls";
import { encodeSelectionMask, selectionMaskEncoding } from "./plan-selection";

export const buildingExtractorVersion = "topology-v10";

export type PlanWord = { text: string; x: number; y: number; width: number; height: number; confidence?: number };
export type PlanLabel = { sourceKey: string; entityType: "room"; name: string; geometry: { quality: "anchor"; coordinateSpace: "normalized-page"; planRegion: Omit<PlanWord, "text" | "confidence">;
  textSource: { method: "native_text" | "ocr"; confidence: number | null } }; quote: string };
// Room names as printed on German and English plans, including common abbreviations.
// A name may be followed by digits, "/", "-" or punctuation ("Bad:", "Kind,", "WC-Anlage").
const roomLabel = new RegExp("^(" + [
  "raum", "zimmer", "wohnen", "wohnzimmer", "wohnzi\\.?", "wohnk(?:ü|ue)che", "wohn[-/]+\\S*", "wohnbereich", "essen", "essbereich", "essplatz", "kochen",
  "schlafen", "schlafzimmer", "schlafzi\\.?", "eltern", "gästezimmer", "gaestezimmer", "gäste-?wc", "gaeste-?wc", "gäste", "garderobe",
  "kinderzimmer", "kinderzi\\.?", "kind", "küche", "kueche", "bad", "badezimmer", "duschbad", "dusche", "wc", "flur", "diele", "eingang", "windfang",
  "ankleide", "vorrat", "speisekammer", "speis", "treppenhaus", "treppe", "abstellraum", "abstellr\\.?", "abstell", "büro", "buero",
  "arbeitszimmer", "arbeiten", "keller", "lager", "technik", "haustechnik", "hausanschlussraum", "hwr", "hauswirtschaft(?:sraum)?",
  "waschküche", "waschkueche", "waschraum", "heizung", "heizraum", "loggia", "balkon", "terrasse", "garage", "carport",
  "room", "bedroom", "living", "kitchen", "bathroom", "office", "corridor", "hall", "storage", "wo\\.-?",
].join("|") + ")(?:$|[\\s/\\d.:,;)\\-])", "i");
// Drawing titles ("Grundriss Keller", "Schnitt Treppe") name sheets, not rooms.
const drawingTitle = /^(grundriss|schnitt|ansicht|lageplan|übersicht|uebersicht|plan|zeichnung|geschoss)$/i;

/** Only source text anchors: no room boundary, material, state, use or wall inference. */
export function planLabels(words: PlanWord[], method: "native_text" | "ocr" = "native_text"): PlanLabel[] {
  const summaries = words.filter(w => /^(zzgl\.?|inkl\.?|incl\.?|plus|total|summe)$/i.test(w.text));
  const titles = words.filter(w => drawingTitle.test(w.text));
  return words.filter(w => roomLabel.test(w.text.normalize("NFC")) && !summaries.some(s => Math.abs(s.y-w.y)<w.height*0.5 && s.x<w.x && w.x-(s.x+s.width)<w.height*2)
    && !titles.some(t => Math.abs(t.y-w.y)<w.height*0.5 && t.x<w.x && w.x-(t.x+t.width)<w.height*2)
    && w.text.length <= 300 && [w.x,w.y,w.width,w.height].every(Number.isFinite)
    && w.x >= 0 && w.y >= 0 && w.width > 0 && w.height > 0 && w.x + w.width <= 1.001 && w.y + w.height <= 1.001)
    .map(w => {
      if (!/^wo\./i.test(w.text)) return w;
      const suffix = words.filter(s => /^(es\.-?|ko\.?)$/i.test(s.text) && Math.abs(s.y-w.y)<w.height*0.5 && s.x>w.x && s.x-(w.x+w.width)<w.height*6).sort((a,b)=>a.x-b.x);
      return suffix.length ? {...w,text:[w.text,...suffix.map(s=>s.text)].join(" "),width:Math.max(...suffix.map(s=>s.x+s.width))-w.x} : w;
    })
    .map(w => ({ sourceKey: createHash("sha256").update(`${w.text}|${w.x.toFixed(5)}|${w.y.toFixed(5)}`).digest("hex"),
      entityType: "room", name: w.text.replace(/[:,;]+$/, ""), quote: w.text,
      geometry: { quality: "anchor", coordinateSpace: "normalized-page", planRegion: { x: w.x, y: w.y, width: w.width, height: w.height },
        textSource: { method, confidence: method === "ocr" ? w.confidence ?? null : null } } }));
}

export function parsePlanBbox(xml: string): PlanWord[] {
  const words: PlanWord[] = []; let pageWidth = 0, pageHeight = 0;
  let current: PlanWord | null = null;
  const parser = new SaxesParser();
  parser.on("opentag", tag => {
    const a = tag.attributes as Record<string,string>;
    if (tag.name === "page") { pageWidth = Number(a.width); pageHeight = Number(a.height); }
    if (tag.name === "word" && pageWidth > 0 && pageHeight > 0) current = { text: "", x: Number(a.xMin)/pageWidth, y: Number(a.yMin)/pageHeight, width: (Number(a.xMax)-Number(a.xMin))/pageWidth, height: (Number(a.yMax)-Number(a.yMin))/pageHeight };
  });
  parser.on("text", text => { if (current) current.text += text; });
  // pdftotext may emit decomposed umlauts (u + combining diaeresis); compare in NFC.
  parser.on("closetag", tag => { if (tag.name === "word" && current) { words.push({ ...current, text: current.text.normalize("NFC") }); current = null; } });
  parser.write(xml).close(); return words;
}

export function parsePlanTsv(tsv: string): PlanWord[] {
  const rows = tsv.trim().split("\n").slice(1).map(line => line.split("\t"));
  const page = rows.find(row => row[0] === "1");
  const width = Number(page?.[8]), height = Number(page?.[9]);
  if (!(width > 0 && height > 0)) return [];
  return rows.filter(row => row[0] === "5" && Number(row[10]) >= 45 && row[11]?.trim()).map(row => ({
    text: row.slice(11).join("\t").trim().normalize("NFC"), x: Number(row[6])/width, y: Number(row[7])/height, width: Number(row[8])/width, height: Number(row[9])/height,
    confidence: Number(row[10]),
  }));
}

export type PlanExtraction = Awaited<ReturnType<typeof analysePlanFile>>;

/** Stream the source to a private temp file, then parse it off the main thread:
 * PDF geometry and raster topology are CPU-bound and would stall the API. */
export async function extractPlanLabels(stream: AsyncIterable<Uint8Array>, page: number, signal: AbortSignal): Promise<PlanExtraction> {
  const directory = await mkdtemp(join(tmpdir(), "richtfest-plan-"));
  try {
    const path = join(directory,"source.pdf");
    await pipeline(Readable.from(stream),createWriteStream(path),{ signal });
    return await inPlanWorker({ path, page }, signal);
  } finally { (stream as {destroy?:()=>void}).destroy?.(); await rm(directory,{recursive:true,force:true}); }
}

function inPlanWorker(input: { path: string; page: number }, signal: AbortSignal) {
  return new Promise<PlanExtraction>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./plan-extraction-thread.ts", import.meta.url));
    const finish = (settle: () => void) => { signal.removeEventListener("abort", abort); worker.terminate(); settle(); };
    const abort = () => finish(() => reject(signal.reason ?? new Error("Plan extraction aborted")));
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: true; result: PlanExtraction } | { ok: false; message: string }>) =>
      finish(() => event.data.ok ? resolve(event.data.result) : reject(new Error(event.data.message)));
    worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(event.message || "Plan extraction worker failed")));
    worker.postMessage(input);
  });
}

/** Runs inside the plan-extraction worker thread (see plan-extraction-thread.ts). */
export async function analysePlanFile(path: string, page: number, signal: AbortSignal) {
  const directory = dirname(path);
  const command = (file: string, args: string[]) => new Promise<string>((resolve,reject) => execFile(file,args,
    { signal, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: "1" } },
    (error,stdout) => error ? reject(error) : resolve(stdout)));
  {
    const info = await command("pdfinfo",[path]);
    const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pageCount || page > pageCount) throw new Error("Requested PDF page does not exist");
    let words = parsePlanBbox(await command("pdftotext",["-f",String(page),"-l",String(page),"-bbox","-enc","UTF-8",path,"-"]));
    let method: "native_text" | "ocr" = "native_text";
    if (!planLabels(words).length) {
      const prefix = join(directory,"page");
      await command("pdftoppm",["-f",String(page),"-l",String(page),"-singlefile","-scale-to","5000","-png",path,prefix]);
      words = parsePlanTsv(await command("tesseract",[prefix+".png","stdout","-l","deu+eng","--psm","11","tsv"]));
      method = "ocr";
    }
    const allLabels = [...new Map(planLabels(words, method).map(label=>[label.sourceKey,label])).values()];
    const labels = allLabels.slice(0,500);
    let footprints: Awaited<ReturnType<typeof extractPlanFootprints>> | null = null;
    try { footprints = await extractPlanFootprints(path,page,signal); } catch { signal.throwIfAborted(); }
    const { candidates: layerCandidates, supplementaryBarriers = [], fillRegions = [], doorSwings = [], barrierLines: layerBarrierLines = [], penSegments = [], pageAspectRatio = 1, ...geometryExtraction } = footprints ?? {candidates:[],status:"unavailable",limitations:"Native PDF geometry could not be read; only text anchors are available."};
    // A flattened print has no construction layer: walls are read from the outlines of the wall pen instead.
    const outline = !layerCandidates.length && penSegments.length ? outlineWallFootprints({ penSegments, doorSwings, aspect: pageAspectRatio, roomLabels: labels.map(label => label.geometry.planRegion) }) : null;
    const footprintCandidates = outline?.footprints.length ? outline.footprints : layerCandidates;
    const barrierLines = outline?.footprints.length ? outline.barrierLines : layerBarrierLines;
    const scales=[...new Set(words.flatMap(w=>/^1:\d{2,4}$/.test(w.text)?[Number(w.text.slice(2))]:[]))];
    const scaleObservation=scales.length===1?{denominator:scales[0],quote:`1:${scales[0]}`,status:"unreviewed",limitations:"Title-block scale is not used for physical area validation until a source dimension chain corroborates it."}:null;
    // The printed scale is unreviewed: it only bounds plausible opening widths and room sizes, never measures them.
    const pageHeightPoints = footprints && "pageHeightPoints" in footprints ? footprints.pageHeightPoints : null;
    const metresPerPageHeight = scaleObservation && pageHeightPoints ? pageHeightPoints / 72 * .0254 * scaleObservation.denominator : null;
    const topology = inferPlanTopology(labels,footprintCandidates,words,1200,supplementaryBarriers,0,fillRegions,pageAspectRatio,undefined,{doorSwings,metresPerPageHeight,barrierLines});
    // The barrier raster goes to its own table (magic selection), never into the job result.
    const selectionMask = { gridSize: topology.selectionMask.gridSize, encoding: selectionMaskEncoding, data: encodeSelectionMask(topology.selectionMask.cells) };
    return { labels:topology.rooms, footprints: topology.assemblies, selectionMask, pageScale: { pageAspectRatio, metresPerPageHeight }, geometryExtraction:{...geometryExtraction,...(outline?{outlineWalls:outline.stats}:{})},topologyCoverage:topology.coverage, pageCount, method, coverage: "selected_page_source_constrained_topology", geometryQuality: "mixed",
      scaleObservation,
      truncated: allLabels.length > labels.length,
      reason: "Unreviewed source labels, apartment-contained regions or explicitly approximate wall-constrained partitions, conservative draft-wall proposals from exact elongated rectangular construction fills, and separate unsupported construction fragments. Openings between facing wall ends (optionally supported by door-swing arcs) are closed for segmentation and recorded as unreviewed room connections. Alternative construction-state geometry is retained as evidence but never unioned into the active barrier scenario. Printed areas guide relative partition capacity and flag severe mismatches; the printed scale only bounds plausible opening widths and room sizes. Partition seams are not source walls. Verified doors, wall continuity, thickness, materials, state, physical scale and completeness remain unestablished." };
  }
}
