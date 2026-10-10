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
  siteId: "berlin-giersstrasse-20";
  address: string;
  /** EPSG:25833 */
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
