import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import { extractPlanFootprints } from "./plan-footprints";
import { inferPlanTopology } from "./plan-topology";

export type PlanWord = { text: string; x: number; y: number; width: number; height: number };
export type PlanLabel = { sourceKey: string; entityType: "room"; name: string; geometry: { quality: "anchor"; coordinateSpace: "normalized-page"; planRegion: Omit<PlanWord, "text"> }; quote: string };
const roomLabel = /^(raum|zimmer|wohnen|wohnzimmer|schlafen|schlafzimmer|kinderzimmer|kind|küche|kueche|bad|duschbad|wc|flur|diele|ankleide|vorrat|treppenhaus|abstellraum|abstellr\.?|abstell|büro|buero|keller|lager|technik|hwr|balkon|terrasse|room|bedroom|kitchen|bathroom|office|corridor|wo\.-?)(?:$|[\s/\d])/i;

/** Only source text anchors: no room boundary, material, state, use or wall inference. */
export function planLabels(words: PlanWord[]): PlanLabel[] {
  const summaries = words.filter(w => /^(zzgl\.?|inkl\.?|incl\.?|plus|total|summe)$/i.test(w.text));
  return words.filter(w => roomLabel.test(w.text) && !summaries.some(s => Math.abs(s.y-w.y)<w.height*0.5 && s.x<w.x && w.x-(s.x+s.width)<w.height*2)
    && w.text.length <= 300 && [w.x,w.y,w.width,w.height].every(Number.isFinite)
    && w.x >= 0 && w.y >= 0 && w.width > 0 && w.height > 0 && w.x + w.width <= 1.001 && w.y + w.height <= 1.001)
    .map(w => {
      if (!/^wo\./i.test(w.text)) return w;
      const suffix = words.filter(s => /^(es\.-?|ko\.?)$/i.test(s.text) && Math.abs(s.y-w.y)<w.height*0.5 && s.x>w.x && s.x-(w.x+w.width)<w.height*6).sort((a,b)=>a.x-b.x);
      return suffix.length ? {...w,text:[w.text,...suffix.map(s=>s.text)].join(" "),width:Math.max(...suffix.map(s=>s.x+s.width))-w.x} : w;
    })
    .map(w => ({ sourceKey: createHash("sha256").update(`${w.text}|${w.x.toFixed(5)}|${w.y.toFixed(5)}`).digest("hex"),
      entityType: "room", name: w.text, quote: w.text,
      geometry: { quality: "anchor", coordinateSpace: "normalized-page", planRegion: { x: w.x, y: w.y, width: w.width, height: w.height } } }));
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
  parser.on("closetag", tag => { if (tag.name === "word" && current) { words.push(current); current = null; } });
  parser.write(xml).close(); return words;
}

export function parsePlanTsv(tsv: string): PlanWord[] {
  const rows = tsv.trim().split("\n").slice(1).map(line => line.split("\t"));
  const page = rows.find(row => row[0] === "1");
  const width = Number(page?.[8]), height = Number(page?.[9]);
  if (!(width > 0 && height > 0)) return [];
  return rows.filter(row => row[0] === "5" && Number(row[10]) >= 45 && row[11]?.trim()).map(row => ({
    text: row.slice(11).join("\t").trim(), x: Number(row[6])/width, y: Number(row[7])/height, width: Number(row[8])/width, height: Number(row[9])/height,
  }));
}

export async function extractPlanLabels(stream: AsyncIterable<Uint8Array>, page: number, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "richtfest-plan-"));
  const command = (file: string, args: string[]) => new Promise<string>((resolve,reject) => execFile(file,args,
    { signal, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: "1" } },
    (error,stdout) => error ? reject(error) : resolve(stdout)));
  try {
    const path = join(directory,"source.pdf");
    await pipeline(Readable.from(stream),createWriteStream(path),{ signal });
    const info = await command("pdfinfo",[path]);
    const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pageCount || page > pageCount) throw new Error("Requested PDF page does not exist");
    let words = parsePlanBbox(await command("pdftotext",["-f",String(page),"-l",String(page),"-bbox","-enc","UTF-8",path,"-"]));
    let method = "native_text";
    if (!planLabels(words).length) {
      const prefix = join(directory,"page");
      await command("pdftoppm",["-f",String(page),"-l",String(page),"-singlefile","-scale-to","5000","-png",path,prefix]);
      words = parsePlanTsv(await command("tesseract",[prefix+".png","stdout","-l","deu+eng","--psm","11","tsv"]));
      method = "ocr";
    }
    const allLabels = [...new Map(planLabels(words).map(label=>[label.sourceKey,label])).values()];
    const labels = allLabels.slice(0,500);
    let footprints: Awaited<ReturnType<typeof extractPlanFootprints>> | null = null;
    try { footprints = await extractPlanFootprints(path,page,signal); } catch { signal.throwIfAborted(); }
    const { candidates: footprintCandidates, supplementaryBarriers = [], fillRegions = [], pageAspectRatio = 1, ...geometryExtraction } = footprints ?? {candidates:[],status:"unavailable",limitations:"Native PDF geometry could not be read; only text anchors are available."};
    const topology = inferPlanTopology(labels,footprintCandidates,words,1200,supplementaryBarriers,0,fillRegions,pageAspectRatio);
    return { labels:topology.rooms, footprints: topology.assemblies, geometryExtraction,topologyCoverage:topology.coverage, pageCount, method, coverage: "selected_page_source_constrained_topology", geometryQuality: "mixed",
      truncated: allLabels.length > labels.length,
      reason: "Unreviewed source labels, enclosed regions or explicitly approximate wall-constrained partitions, and construction-fragment assemblies. Partition seams are not source walls. Printed areas are observations requiring separate review, not approved measurements. Doors, adjacency, semantic walls, materials, state, scale and completeness remain unestablished." };
  } finally { (stream as {destroy?:()=>void}).destroy?.(); await rm(directory,{recursive:true,force:true}); }
}
