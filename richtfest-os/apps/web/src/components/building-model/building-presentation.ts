import { geometryArea, intersectGeometry, unionGeometry, type GeometryMultiPolygon } from "@richtfest/shared/site-geometry";
import { placementForPage, planToSite, type LocationContext, type Point2, type StoredPlacement } from "@richtfest/shared";
import type { ViewportState } from "../location/viewport";
import type { buildingVolumeGeometry } from "./room-volumes";
import type { BuildingRegion } from "./types";

type Mesh = NonNullable<ViewportState["assessment"]>[number];
type Floor = ReturnType<typeof buildingVolumeGeometry>[number];
const plaster = 0xd9d1bf, frame = 0x414b50;
const rectangle = (x: number, z: number, w: number, d: number): GeometryMultiPolygon =>
  [[[[x, z], [x + w, z], [x + w, z + d], [x, z + d], [x, z]]]];
const closed = (polygons: GeometryMultiPolygon): GeometryMultiPolygon => polygons.map(polygon => polygon.map(ring =>
  ring.length && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) ? [...ring, ring[0]!] : ring));
const dimension = (object: BuildingRegion, key: string, fallback: number) => {
  const p = object.componentProperties?.[key];
  return p && !["rejected", "superseded"].includes(p.reviewStatus) && typeof p.value === "number" && Number.isFinite(p.value) && p.value > 0 ? p.value : fallback;
};

/** A saved, source-matched site anchor; never centre an unplaced model on an address. */
export function buildingSiteTransform(floors: Floor[], context: LocationContext | null, stored: StoredPlacement | null | undefined) {
  if (!context || !stored || stored.alignmentStatus === "unknown") return null;
  const anchor = floors.find(floor => floor.source.source?.versionId && placementForPage(stored,
    { sourceVersionId: floor.source.source.versionId, page: floor.source.page }, context.crs ?? "EPSG:25833"));
  if (!anchor || floors.some(floor => floor.source.source?.versionId !== anchor.source.source?.versionId)) return null;
  const placement = placementForPage(stored, { sourceVersionId: anchor.source.source!.versionId, page: anchor.source.page }, context.crs ?? "EPSG:25833")!;
  return (point: Point2): Point2 => {
    const [east, north] = planToSite([point[0] + anchor.origin[0], point[1] + anchor.origin[1]], placement);
    return [east - context.origin[0], context.origin[1] - north];
  };
}

/** Disposable presentation of the same persisted outlines. Never writes inferred
 * opening types, finishes, furnishings, slabs or roof caps to the engineering model. */
export function buildingPresentation(floors: Floor[]) {
  const meshes: Mesh[] = [];
  let provisionalOpenings = 0, placedOpenings = 0, furnishedRooms = 0;
  for (const floor of floors) {
    if (!floor.scale?.metresPerPageHeight || !floor.meshes.length) continue;
    const h = floor.scale.metresPerPageHeight, aspect = floor.scale.pageAspectRatio;
    const roomIds = new Set(floor.volumes.map(item => item.room.id));
    const walls = floor.meshes.filter(mesh => !roomIds.has(mesh.id));
    const floorPieces: GeometryMultiPolygon[] = [];
    const add = (id: string, polygons: GeometryMultiPolygon, base: number, height: number, color: number, extra: Partial<Mesh> = {}) => {
      if (height <= 0 || !polygons.length) return;
      meshes.push({ id, polygons, base: floor.base + base, height, color, group: floor.source.id,
        opacity: 1, edges: false, ...extra });
    };
    for (const wall of walls) {
      add(wall.id, wall.polygons, 0, wall.height, plaster, { section: true });
      floorPieces.push(closed(wall.polygons));
    }
    const metric = (ring: { x: number; y: number }[]) => ring.map(p => [p.x * h * aspect - floor.origin[0], p.y * h - floor.origin[1]] as [number, number]);
    const canonical = floor.objects.filter(object => !object.isCandidate && object.entityType === "element"
      && ["window", "door"].includes(String(object.componentProperties?.componentType?.value ?? object.elementKind)) && object.polygon?.length);
    const openings = canonical.map(object => ({ id: object.id, object, polygons: [ [metric(object.polygon!)] ],
      door: (object.componentProperties?.componentType?.value ?? object.elementKind) === "door", provisional: false }));
    // Render traced gaps only when their jamb evidence belongs to the displayed
    // construction state. This is illustrative infill, NOT an exterior/escape connection.
    for (const evidence of floor.openingEvidence) {
      if (["rejected", "superseded"].includes(evidence.status ?? "") || !["vertical", "horizontal"].includes(evidence.wallAxis)) continue;
      const host = floor.objects.find(object => walls.some(wall => wall.id === object.id)
        && object.sourceFootprintKeys?.some(key => evidence.sourceKeys.includes(key)));
      if (!host) continue;
      const b = evidence.closure;
      if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) continue;
      const polygons = rectangle(b.x * h * aspect - floor.origin[0], b.y * h - floor.origin[1], b.width * h * aspect, b.height * h);
      // A canonical opening replaces the preview at that location, including its dimensions.
      if (openings.some(opening => geometryArea(intersectGeometry(closed(opening.polygons), polygons)) > .001)) continue;
      openings.push({ id: host.id, object: host, polygons, door: !!evidence.doorSwingKey || evidence.kind.startsWith("door_swing"), provisional: true });
    }
    for (const opening of openings) {
      const ring = opening.polygons[0]![0]!;
      const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
      const x = Math.min(...xs), z = Math.min(...zs), w = Math.max(...xs) - x, d = Math.max(...zs) - z;
      if (w <= 0 || d <= 0) continue;
      const vertical = d > w, length = Math.max(w, d);
      if (length < .25 || length > 5) continue;
      const openingHeight = Math.min(floor.height - .1, opening.provisional ? (opening.door ? 2.1 : 1.4) : dimension(opening.object, "openingHeight", opening.door ? 2.1 : 1.4));
      const sill = opening.door ? 0 : Math.max(0, Math.min(.9, floor.height - openingHeight - .1));
      const top = sill + openingHeight;
      add(opening.id, opening.polygons, 0, sill, plaster, { section: true });
      add(opening.id, opening.polygons, top, floor.height - top, plaster, { section: true });
      const strip = (along: number, width: number, depth: number) => vertical
        ? rectangle(x + (w - depth) / 2, z + along, depth, width)
        : rectangle(x + along, z + (d - depth) / 2, width, depth);
      const section = { section: true };
      add(opening.id, strip(0, length, .085), sill, .07, frame, section);
      add(opening.id, strip(0, length, .085), top - .07, .07, frame, section);
      for (const along of [0, length - .07, ...(length > 1.1 ? [length / 2 - .035] : [])])
        add(opening.id, strip(along, .07, .085), sill + .07, openingHeight - .14, frame, section);
      add(opening.id, strip(.07, length - .14, .025), sill + .07, openingHeight - .14,
        opening.door ? 0xb29a78 : 0x82aab9, { ...section, opacity: opening.door ? 1 : .62, metalness: opening.door ? 0 : .25, roughness: .22 });
      floorPieces.push(closed(opening.polygons));
      if (opening.provisional) provisionalOpenings++; else placedOpenings++;
    }
    for (const volume of floor.volumes) {
      const object = volume.room;
      const mesh = floor.meshes.find(mesh => mesh.id === object.id)!;
      const polygons = closed(mesh.polygons);
      floorPieces.push(polygons);
      const name = `${object.roomUse ?? ""} ${object.label}`.toLowerCase();
      const wet = /bad|bath|wc|küche|kitchen/.test(name), living = /wohn|living|wo\.\s*-\s*es/.test(name), bedroom = /schlaf|sleep|bedroom|kind/.test(name);
      add(object.id, polygons, .015, .035, wet ? 0xbdbdb4 : 0xc5ab83);
      // Furniture must fit wholly inside the source room, including its holes.
      // These are removable illustration meshes attached to that room's ID.
      if (!wet && !living && !bedroom) continue;
      const ring = polygons[0]![0]!, xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const w = bedroom ? 1.6 : wet ? 1.2 : 2.1, d = bedroom ? 2.1 : wet ? .65 : .9;
      const x = cx - w / 2, z = cz - d / 2, footprint = rectangle(x - .15, z - .15, w + .3, d + .3);
      if (geometryArea(intersectGeometry(footprint, polygons)) < (w + .3) * (d + .3) - .001) continue;
      furnishedRooms++;
      if (bedroom && !wet && !living) {
        add(object.id, rectangle(x, z, w, d), .1, .25, 0x66584b);
        add(object.id, rectangle(x + .04, z + .04, w - .08, d - .08), .35, .2, 0xeee8db);
        add(object.id, rectangle(x + .04, z + .7, w - .08, d - .75), .55, .035, 0x7f9291);
        add(object.id, rectangle(x, z - .06, w, .1), .1, .85, 0x8f7c66);
        for (const offset of [.12, .87]) add(object.id, rectangle(x + offset, z + .12, .6, .4), .55, .1, 0xf8f5ed);
      } else if (living) {
        add(object.id, rectangle(x, z, w, d), .15, .32, 0x8d9a96);
        add(object.id, rectangle(x, z, w, .18), .47, .38, 0x8d9a96);
        for (const offset of [0, w - .17]) add(object.id, rectangle(x + offset, z, .17, d), .47, .2, 0x8d9a96);
        const seatingArea = rectangle(x - .2, z + d, w + .4, 1.65);
        if (geometryArea(intersectGeometry(seatingArea, polygons)) >= (w + .4) * 1.65 - .001) {
          add(object.id, seatingArea, .055, .015, 0xe3d8c2);
          add(object.id, rectangle(cx - .55, z + d + .4, 1.1, .65), .12, .32, 0x756653);
          add(object.id, rectangle(cx - .6, z + d + .35, 1.2, .75), .44, .05, 0xd9c5a2);
        }
      } else {
        add(object.id, rectangle(x, z, w, d), .1, .75, 0xe5e0d5);
        add(object.id, rectangle(x - .03, z - .03, w + .06, d + .06), .85, .05, 0x858680);
      }
    }
    if (floorPieces.length) {
      const slab = unionGeometry(...floorPieces);
      add(floor.storey.id, slab, -.25, .25, 0xb9b6aa);
      // A horizontal cap expresses the known plan extent, not an invented roof slope.
      // It disappears in the selected floor's cutaway. No convex hull bridges courtyards or separate buildings.
      add(floor.storey.id, slab, floor.height, .05, 0x8d9696, { roof: true });
    }
  }
  return { meshes, provisionalOpenings, placedOpenings, furnishedRooms };
}
