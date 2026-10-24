import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileSearch } from "lucide-react";
import type { DocumentType } from "@richtfest/shared";
import { useT } from "../../i18n";
import { useApi } from "../../query";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type T = ReturnType<typeof useT>;
type SourceGroup = { fields: string[]; reason: Parameters<T>[0]; documents: DocumentType[]; view?: string };

/** Every component input has an evidence route. Document types identify candidates, never facts. */
export const buildingInputSources: SourceGroup[] = [
  { fields: ["federalState"], reason: "buildingInputAddress", documents: [], view: "details" },
  { fields: ["bebauungsplan", "bebauungsplanNoise", "bebauungsplanAreaType", "bebauungsplanGrz", "bebauungsplanGfz", "bebauungsplanStoreys", "bebauungsplanHeight", "bebauungsplanBauweise", "gfzCountingBasis"], reason: "buildingInputPlanning", documents: ["development_plan", "permit"], view: "feasibility&study=site&step=limits" },
  { fields: ["stateBuildingCodeEdition", "vvtbEdition", "din4109Edition"], reason: "buildingInputEdition", documents: ["permit", "acoustic_report", "fire_safety_concept"] },
  { fields: ["soundInsulationLevel"], reason: "buildingInputAgreement", documents: ["acoustic_report", "construction_description", "correspondence"] },
  { fields: ["exteriorNoiseApplicability"], reason: "buildingInputAcousticMethod", documents: ["acoustic_report"], view: "noise&step=exterior" },
  { fields: ["exteriorNoiseFlanking"], reason: "buildingInputFlanking", documents: ["acoustic_report", "construction_description"], view: "noise&step=exterior" },
  { fields: ["construction", "material", "thickness", "bulkDensity"], reason: "buildingInputDescription", documents: ["construction_description", "plans", "acoustic_report"] },
  { fields: ["openingWidth", "openingHeight", "openingArea", "surfaceArea", "elementCount"], reason: "buildingInputDimensions", documents: ["plans", "construction_description"] },
  { fields: ["clearRoomHeight"], reason: "buildingInputClearHeight", documents: ["plans"] },
  { fields: ["screedType", "screedMass", "screedStiffness", "screedInsulation", "liningType", "liningMass", "liningStiffness", "liningCavity", "liningSides", "timberWallLining", "timberCeilingUnderside", "glazing", "windowFrame", "rebateSeals", "windowOpening", "frameShare", "glazingBars", "doorLeafType", "stairCase", "installationKind", "installationProof"], reason: "buildingInputAssembly", documents: ["construction_description", "acoustic_report", "plans"] },
  { fields: ["soundReductionIndex", "soundReductionIndexBasis", "normalizedLevelDifference", "flankingLevelDifference", "doorLeafSoundReduction", "rebateSealSoundReduction", "floorSealSoundReduction", "glassSoundReduction", "impactSoundReduction", "serviceSoundLevel", "serviceSoundLevelBasis"], reason: "buildingInputAcousticProof", documents: ["acoustic_report", "construction_description"] },
  { fields: ["lightweightCatalogueRow"], reason: "buildingInputCatalogue", documents: ["construction_description", "acoustic_report"] },
  { fields: ["componentType", "wallRole", "ceilingRole", "doorRole", "isExternal"], reason: "buildingInputTopology", documents: ["plans"] },
  { fields: ["apartmentUnit", "spaceType", "exteriorNoiseRoom", "serviceReceivingUse"], reason: "buildingInputRoomUse", documents: ["plans", "construction_description", "acoustic_report"] },
  { fields: ["storeyInventory", "exteriorSurfacesComplete", "referenceBuildUpConfirmed", "installationConditionsConfirmed"], reason: "buildingInputConfirmation", documents: ["plans", "construction_description"] },
  { fields: ["fireHeight"], reason: "buildingInputFireHeight", documents: ["plans", "fire_safety_concept"] },
  { fields: ["fireDwellings", "fireOtherUnits"], reason: "buildingInputUnits", documents: ["plans", "construction_description", "fire_safety_concept"] },
  { fields: ["fireUsableArea", "fireLargestUnitArea", "fireUnitsGrossArea", "garageArea", "grossFloorArea", "countableFloorArea"], reason: "buildingInputAreas", documents: ["plans", "construction_description", "fire_safety_concept"] },
  { fields: ["fireDetached", "fireSpecialUse", "garageEnclosure", "fireRoomRole"], reason: "buildingInputFireUse", documents: ["fire_safety_concept", "plans", "permit"] },
  { fields: ["stairwellSmokeVent"], reason: "buildingInputSmokeVent", documents: ["fire_safety_concept", "plans", "construction_description"] },
  { fields: ["loadBearing"], reason: "buildingInputLoadBearing", documents: ["plans", "construction_description"] },
  { fields: ["fireResistance", "fireResistanceBasis", "fireClosure"], reason: "buildingInputFireProof", documents: ["fire_safety_concept", "construction_description"] },
  { fields: ["fireRescueWindow", "fireRescueLocation", "fireRescueClearWidth", "fireRescueClearHeight", "fireRescueSillHeight", "fireRescueOpenableInside"], reason: "buildingInputRescueWindow", documents: ["fire_safety_concept", "plans", "construction_description"] },
  { fields: ["fullStorey"], reason: "buildingInputFullStorey", documents: ["plans", "permit"] },
  { fields: ["parcelArea"], reason: "buildingInputParcel", documents: ["plans", "permit"], view: "feasibility&study=site&step=limits" },
  { fields: ["footprintArea"], reason: "buildingInputFootprint", documents: ["plans"] },
  { fields: ["level"], reason: "buildingInputLevel", documents: ["plans"] },
];

type SourceFile = { id: string; name: string; versionId: string; purpose: string; documentType?: { documentType: DocumentType | null } | null };

function InputSourceDetails({ group, label, t }: { group: SourceGroup; label: string; t: T }) {
  const { id: projectId } = useParams();
  // Only mounted when opened; all fields share the project's existing file-list cache.
  const query = useApi(`/projects/${projectId}/files`, Boolean(projectId && group.documents.length));
  const files = (Array.isArray(query.data) ? query.data : []) as SourceFile[];
  const candidates = files.filter(file => file.purpose === "project_evidence" && file.documentType?.documentType && group.documents.includes(file.documentType.documentType));
  return <div className="grid gap-stack text-ui-xs">
    <strong>{label}</strong>
    <p>{t(group.reason)}</p>
    {projectId && <>
      {group.view && <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=${group.view}`}>{t(group.view === "details" ? "projectDetails" : group.view.startsWith("noise") ? "noiseNav" : "buildingPlanningContext")} →</Link>}
      {group.documents.length > 0 && <>
        {query.isPending ? <span>{t("loading")}</span> : query.isError ? <Button variant="outline" size="xs" onClick={() => void query.refetch()}>{t("retry")}</Button>
          : candidates.length ? <>
            <span className="muted">{t("buildingInputCandidates")} · {candidates.length}</span>
            {candidates.map(file => <Link className="underline underline-offset-2 break-words" key={file.id} to={`/projects/${projectId}?panel=documents&file=${file.id}&sourceVersion=${file.versionId}`}>{file.name}</Link>)}
          </> : <span className="muted">{t("buildingInputNoCandidate")}</span>}
        <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=sources`}>{t("buildingInputOpenSources")} →</Link>
      </>}
    </>}
  </div>;
}

/** On-demand explanation rather than another helper paragraph under every empty control. */
export function InputSourceHelp({ field, label, t }: { field: string; label: string; t: T }) {
  const [open, setOpen] = useState(false);
  const group = buildingInputSources.find(group => group.fields.includes(field));
  if (!group) return null;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`${t("buildingInputFindSource")}: ${label}`} title={t("buildingInputFindSource")}><FileSearch className="size-icon-sm" /></Button></PopoverTrigger>
    <PopoverContent align="start" className="building-model-property-suggestions">
      {open && <InputSourceDetails group={group} label={label} t={t} />}
    </PopoverContent>
  </Popover>;
}
