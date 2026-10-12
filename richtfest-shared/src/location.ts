import { z } from "zod";

const addressText = (max: number) => z.string().trim().max(max).nullable().optional().transform(value => value === "" ? null : value);
export const projectAddressInput = z.object({
  street: addressText(300),
  postalCode: addressText(32),
  city: addressText(200),
  country: addressText(100),
});
export type ProjectAddress = z.infer<typeof projectAddressInput>;
/** Search provenance, not surveyed coordinates or proof of address validity. */
export const addressReferenceInput = z.object({
  provider: z.literal("geoapify"),
  placeId: z.string().min(1).max(2000),
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  attribution: z.string().min(1).max(2000),
});
export type AddressReference = z.infer<typeof addressReferenceInput>;
export type AddressSuggestion = ProjectAddress & { addressReference: AddressReference };
export type AddressSuggestions = { configured: boolean; suggestions: AddressSuggestion[] };
export const formatProjectAddress = (address: ProjectAddress) => [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.country].filter(Boolean).join(", ");
const normalAddress = (text: string) => text.trim().toLocaleLowerCase("de").replaceAll("ß", "ss").replace(/[\s,]+/g, " ");
const germanAddress = (address: ProjectAddress) => !address.country || ["de", "deutschland", "germany"].includes(normalAddress(address.country));
const projectAddressKey = (address: ProjectAddress) => [address.street, address.postalCode, address.city, germanAddress(address) ? "de" : address.country].map(value => normalAddress(value || "")).join("|");
export const locationMatchesAddress = (context: LocationContext, address: ProjectAddress) => context.projectAddress
  ? projectAddressKey(context.projectAddress) === projectAddressKey(address)
  : germanAddress(address) && normalAddress(context.address) === normalAddress(formatProjectAddress({ ...address, country: null }));

/** Scene coordinates are metres: X east, Y up, Z south. Ground is a local reference, not surveyed flat terrain. */
export type SceneVector = [number, number, number];
export type SceneObject = {
  id: string;
  kind: "vehicle" | "mass" | "note" | "ifc";
  label: string;
  position: SceneVector;
  size: SceneVector;
  rotation: number;
  note: string;
  source?: { fileId: string; version: number };
};
export type LocationScene = {
  objects: SceneObject[];
  planningNotes: string;
};
export type LocationBuilding = {
  id: string;
  /** Polygons, each containing an outer ring and optional holes, in local X/Z metres. */
  polygons: [number, number][][][];
  height: number | null;
  label: string;
  roof: string | null;
  sourceId: string;
};
export type LocationTree = {
  id: string;
  position: [number, number];
  height: number | null;
  crownDiameter: number | null;
  species: string;
  sourceId: string;
};
export type LocationContext = {
  siteId: string;
  /** Saved address used for this import; absent on legacy fixed-site scenes. */
  projectAddress?: ProjectAddress;
  address: string;
  /** Legacy contexts omit this and use EPSG:25833 (Berlin). */
  crs?: "EPSG:25832" | "EPSG:25833";
  /** Metres in crs. Rheinland-Pfalz uses EPSG:25832. */
  origin: [number, number];
  longitude: number;
  latitude: number;
  radius: number;
  buildings: LocationBuilding[];
  trees: LocationTree[];
  sources: { label: string; url: string; surveyedAt: string | null }[];
  importedAt: string;
};
export type LocationJob = {
  status: "idle" | "queued" | "running" | "ready" | "failed";
  error: string | null;
};
export type LocationState = {
  revision: number;
  scene: LocationScene;
  context: LocationContext | null;
  contextJob: LocationJob;
  lidarJob: LocationJob;
};
export type LocationPointCloud = {
  /** Flat XYZ array in the same local coordinate frame as the scene. */
  positions: number[];
  classifications: number[];
  groundElevation: number;
  sourcePointCount: number;
  sampled: boolean;
  surveyedAt: string;
  sourceUrl: string;
};
