import { Link, useSearchParams } from "react-router-dom";
import { buildingConnectionTypes, isActiveBuildingRelationship, type BuildingRelationship } from "@richtfest/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import type { BuildingModel, BuildingRegion } from "./types";

const relationLabels: Record<string, Parameters<ReturnType<typeof useT>>[0]> = {
  separates: "buildingConnectionBounds", faces_exterior: "buildingConnectionExterior", opening_in: "buildingConnectionHost",
  covers: "buildingConnectionCovers", under_storey: "buildingConnectionUpperStorey",
};

/** Stored claims, not another topology inferred from the rendered meshes. */
export function BuildingConnections({ model, objects, selected, hrefFor, onReview, onDerive, pending }: {
  model: BuildingModel; objects: BuildingRegion[]; selected?: BuildingRegion;
  hrefFor: (object: BuildingRegion) => string;
  onReview: (relationship: BuildingRelationship, decision: "approved" | "rejected") => void;
  onDerive: () => void; pending: boolean;
}) {
  const t = useT(), [params] = useSearchParams();
  const canonical = objects.filter(object => !object.isCandidate);
  const allObjects = new Map(Object.values(model.states).flat().map(object => [object.id, object]));
  const relevant = model.relationships.filter(link => (buildingConnectionTypes as readonly string[]).includes(link.relationshipType)
    && (selected ? link.fromEntityId === selected.id || link.toEntityId === selected.id
      : canonical.some(object => object.id === link.fromEntityId || object.id === link.toEntityId)));
  const active = relevant.filter(isActiveBuildingRelationship);
  const pendingCount = relevant.filter(link => link.reviewStatus === "unreviewed" || link.reviewStatus === "proposed").length;
  const endpoint = (id: string) => {
    const object = allObjects.get(id);
    if (object) return <Link className="underline underline-offset-2" to={hrefFor(object)}>{object.label}</Link>;
    const storey = model.storeys.find(item => item.id === id), source = model.planSources.find(item => item.storeyId === id);
    if (storey && source) {
      const next = new URLSearchParams(params); next.delete("entity"); next.delete("candidate");
      next.set("storey", id); next.set("page", String(source.page)); next.set("floorFocus", "1"); next.set("sourceSelection", "manual");
      if (source.source?.versionId) next.set("sourceVersion", source.source.versionId);
      return <Link className="underline underline-offset-2" to={`?${next}`}>{storey.name}</Link>;
    }
    return <span>{t("buildingConnectionMissingObject")}</span>;
  };
  const isWall = selected?.elementKind === "draft_wall" || selected?.elementKind === "wall" || selected?.componentProperties?.componentType?.value === "wall";
  const isOpening = selected?.elementKind === "window" || selected?.elementKind === "door";
  const missingSides = isWall ? [0, 1].filter(side => !active.some(link => ["separates", "faces_exterior"].includes(link.relationshipType) && link.metadata?.side === side)) : [];
  const hostCount = active.filter(link => link.relationshipType === "opening_in" && link.fromEntityId === selected?.id).length;
  return <section className="grid gap-stack" aria-label={t("buildingConnections")}>
    <Callout>{t("buildingConnectionDisclaimer")}</Callout>
    <Button variant="outline" disabled={pending || !canonical.length} onClick={onDerive}>{t("buildingConnectionDerive")}</Button>
    <p className="text-ui-xs text-muted-foreground">{t("buildingConnectionDeriveHint")}</p>
    <div className="flex flex-wrap gap-2 text-ui-xs"><Badge>{t("buildingConnectionPending").replace("{count}", String(pendingCount))}</Badge><Badge>{t("buildingConnectionConfirmedCount").replace("{count}", String(active.filter(link => link.reviewStatus === "approved").length))}</Badge></div>
    {!selected && <div className="building-room-volume-list">
      {canonical.map(object => <Link key={object.id} to={hrefFor(object)}><span>{object.label}</span><span>{t("buildingConnectionCount").replace("{count}", String(active.filter(link => link.fromEntityId === object.id || link.toEntityId === object.id).length))}</span></Link>)}
    </div>}
    {selected && <h3 className="text-ui-sm font-semibold">{selected.label}</h3>}
    {selected?.isCandidate || !canonical.length ? <Callout>{t("buildingConnectionDraft")}</Callout> : <>
      {selected?.entityType === "room" && !active.some(link => link.relationshipType === "separates") && <Callout>{t("buildingConnectionNoBoundaries")}</Callout>}
      {missingSides.map(side => <Callout key={side}>{t("buildingConnectionMissingSide").replace("{side}", String(side + 1))}</Callout>)}
      {isOpening && hostCount !== 1 && <Callout>{t(hostCount ? "buildingConnectionAmbiguousHost" : "buildingConnectionMissingHost")}</Callout>}
      {!relevant.length && <p className="text-ui-sm text-muted-foreground">{t("buildingConnectionEmpty")}</p>}
      <ul className="grid gap-stack">
        {(selected ? relevant : []).map(link => {
          const next = new URLSearchParams(params), metadata = link.metadata;
          next.set("modelView", "2d"); next.delete("candidate"); next.set("entity", `${link.fromEntityType}:${link.fromEntityId}`);
          if (typeof metadata?.sourceVersionId === "string") next.set("sourceVersion", metadata.sourceVersionId);
          if (typeof metadata?.page === "number") next.set("page", String(metadata.page));
          const reviewable = link.reviewStatus !== "superseded";
          return <li key={link.id} className="grid gap-2 border-t py-cell" data-connection-id={link.id}>
            <div className="flex flex-wrap items-center gap-2"><strong className="text-ui-xs">{t(relationLabels[link.relationshipType]!)}</strong><Badge>{t(`buildingConnectionStatus_${link.reviewStatus}`)}</Badge></div>
            <div className="text-ui-sm">{endpoint(link.fromEntityId)} → {endpoint(link.toEntityId)}</div>
            <p className="text-ui-xs text-muted-foreground">{typeof metadata?.method === "string" ? `${t("buildingConnectionInferred")} · ${metadata.method}` : t("buildingConnectionOriginUnknown")}{typeof metadata?.side === "number" ? ` · ${t("buildingConnectionSide").replace("{side}", String(metadata.side + 1))}` : ""}</p>
            {typeof metadata?.sourceVersionId === "string" && typeof metadata?.page === "number" && <Link className="text-ui-xs underline underline-offset-2" to={`?${next}`}>{t("buildingConnectionSource").replace("{page}", String(metadata.page))}</Link>}
            {reviewable && <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pending || link.reviewStatus === "approved"} onClick={() => onReview(link, "approved")}>{t("buildingConnectionConfirm")}</Button>
              <Button variant="ghost" size="sm" disabled={pending || link.reviewStatus === "rejected"} onClick={() => onReview(link, "rejected")}>{t("buildingConnectionReject")}</Button>
            </div>}
          </li>;
        })}
      </ul>
    </>}
    <p className="text-ui-xs text-muted-foreground">{t("buildingConnectionAlignmentGap")}</p>
  </section>;
}
