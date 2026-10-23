import { expect, test } from "bun:test";
import { sourceFactInput } from "@richtfest/shared";
import { extractIfcModel, isIfcSource } from "./ifc-model";

const fixture = (schema = "IFC4") => new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('tiny.ifc','',(),(),'test','test','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCUNITASSIGNMENT((#2,#3));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('wall',$,'Wall',$,$,#999,#998,$${schema === "IFC4" ? ",.NOTDEFINED." : ""});
#11=IFCBUILDINGSTOREY('storey',$,'Level',$,$,$,$,$,.ELEMENT.,0.);
#12=IFCWALLTYPE('type',$,'Type',$,$,(#30),$,$,$,.NOTDEFINED.);
#20=IFCPROPERTYSINGLEVALUE('Explicit',$,IFCLENGTHMEASURE(2.),#5);
#21=IFCPROPERTYSINGLEVALUE('Default',$,IFCLENGTHMEASURE(2000.),$);
#22=IFCPROPERTYSINGLEVALUE('Unknown',$,IFCLOGICAL(.U.),$);
#23=IFCPROPERTYSINGLEVALUE('Boolean',$,IFCBOOLEAN(.F.),$);
#24=IFCPROPERTYSINGLEVALUE('Absent',$,$,$);
#25=IFCPROPERTYLISTVALUE('List',$,(IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.)),#5);
#26=IFCPROPERTYSET('pset',$,'Instance',$,(#20,#21,#22,#23,#24,#25));
#27=IFCRELDEFINESBYPROPERTIES('rel',$,$,$,(#10),#26);
#28=IFCPROPERTYSINGLEVALUE('Default',$,IFCLENGTHMEASURE(3.),#5);
#30=IFCPROPERTYSET('typepset',$,'Type',$,(#28));
#31=IFCRELDEFINESBYTYPE('typerel',$,$,$,(#10),#12);
#40=IFCQUANTITYLENGTH('Length',$,#5,2.${schema === "IFC4" ? ",$" : ""});
#41=IFCQUANTITYAREA('Area',$,$,4.${schema === "IFC4" ? ",$" : ""});
#42=IFCELEMENTQUANTITY('qty',$,'Declared',$,$,(#40,#41));
#43=IFCRELDEFINESBYPROPERTIES('qtyrel',$,$,$,(#10),#42);
#50=IFCRELCONTAINEDINSPATIALSTRUCTURE('contains',$,$,$,(#10),#11);
#51=IFCRELAGGREGATES('aggregate',$,$,$,#1,(#11));
ENDSEC;
END-ISO-10303-21;`);

for (const schema of ["IFC4", "IFC2X3"]) test(`${schema}: declared facts, identity, scope and units in real Bun WASM`, async () => {
  const result = await extractIfcModel(fixture(schema));
  const fact = (predicate: string, entityKey = "#10") => result.facts.find(f => f.entityKey === entityKey && f.predicate === predicate)!;
  expect(result.metadata.schema).toBe(schema);
  expect(result.metadata.parserVersion).toBe("0.0.78");
  expect(result.entities.find(e => e.key === "#10")).toEqual({ key: "#10", kind: "IFCWALL", name: "Wall", globalId: "wall" });
  expect(result.entities.some(e => e.key === "#12")).toBe(true);
  expect(fact("instance.Instance.Explicit").value).toEqual({ type: "number", value: 2 });
  expect(fact("instance.Instance.Explicit").unit?.source).toBe("explicit");
  expect(fact("instance.Instance.Default").unit?.source).toBe("project-default");
  expect(fact("instance.Instance.Default").value).toEqual({ type: "number", value: 2000 });
  expect(fact("instance.Instance.Unknown").value).toEqual({ type: "logical", value: "unknown" });
  expect(fact("instance.Instance.Boolean").value).toEqual({ type: "boolean", value: false });
  expect(fact("instance.Instance.Absent")).toBeUndefined();
  expect(fact("instance.Instance.List").value.type).toBe("structured");
  expect(fact("instance.Instance.List").value.value).toMatchObject({ ListValues: [{ ifcType: "IFCLENGTHMEASURE", value: 1 }, { ifcType: "IFCLENGTHMEASURE", value: 2 }] });
  expect(fact("type.Type.Default", "#12").unit?.source).toBe("explicit");
  expect(fact("type.Type.Default")).toBeUndefined();
  expect(fact("type").value).toEqual({ type: "reference", value: "#12" });
  expect(fact("instance.Declared.Length").evidence).toEqual({ kind: "ifc", expressId: 40, attribute: "LengthValue", relationshipId: 43, dataType: "IFCLENGTHMEASURE" });
  expect(fact("instance.Declared.Length").value).toEqual({ type: "number", value: 2 });
  expect(fact("instance.Declared.Area").unit?.source).toBe("project-default");
  expect(fact("containedIn").value).toEqual({ type: "reference", value: "#11" });
  expect(fact("decomposes", "#11").value).toEqual({ type: "reference", value: "#1" });
  expect(result.facts.some(f => ["Representation", "ObjectPlacement", "OwnerHistory"].includes(f.predicate))).toBe(false);
  expect(result.entities.some(e => ["#998", "#999"].includes(e.key))).toBe(false);
  expect(fact("instance.Instance.Explicit").evidence).toMatchObject({ dataType: "IFCLENGTHMEASURE" });
  for (const f of result.facts) expect(sourceFactInput.safeParse(f).success).toBe(true);
  expect(await extractIfcModel(fixture(schema))).toEqual(result);
});

for (const schema of ["IFC4", "IFC2X3"]) test(`${schema}: boundary, void and filling declarations retain direction and independent identity`, async () => {
  const bytes = new TextEncoder().encode(new TextDecoder().decode(fixture(schema)).replace("#50=", `
#60=IFCSPACE('room',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#61=IFCSPACE('room2',$,'Other room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#62=IFCOPENINGELEMENT('opening',$,'Opening',$,$,$,$,$${schema === "IFC4" ? ",.OPENING." : ""});
#63=IFCDOOR('door',$,'Door',$,$,$,$,$,2.,1.${schema === "IFC4" ? ",.DOOR.,.NOTDEFINED.,$" : ""});
#70=IFCRELSPACEBOUNDARY('boundary',$,'Declared',$,#60,#63,$,.PHYSICAL.,.INTERNAL.);
#71=IFCRELSPACEBOUNDARY('boundary2',$,$,$,#61,#63,$,.PHYSICAL.,.INTERNAL.);
#72=IFCRELSPACEBOUNDARY('conflict',$,$,$,#60,#63,$,.PHYSICAL.,.EXTERNAL.);
#73=IFCRELSPACEBOUNDARY('virtual',$,$,$,#60,$,$,.VIRTUAL.,.INTERNAL.);
#74=IFCRELVOIDSELEMENT('void',$,$,$,#10,#62);
#75=IFCRELFILLSELEMENT('fill',$,$,$,#62,#63);
#76=IFCRELSPACEBOUNDARY('repeated',$,$,$,#60,#63,$,.PHYSICAL.,.INTERNAL.);
#50=`));
  const result = await extractIfcModel(bytes);
  const fact = (id: number, predicate: string) => result.facts.find(f => f.entityKey === `#${id}` && f.predicate === predicate)!;
  for (const [id, attribute, target] of [
    [70, "RelatingSpace", 60], [70, "RelatedBuildingElement", 63],
    [71, "RelatingSpace", 61], [71, "RelatedBuildingElement", 63],
    [74, "RelatingBuildingElement", 10], [74, "RelatedOpeningElement", 62],
    [75, "RelatingOpeningElement", 62], [75, "RelatedBuildingElement", 63],
  ] as const) {
    expect(fact(id, attribute)).toEqual({ entityKey: `#${id}`, predicate: attribute, kind: "relationship", value: { type: "reference", value: `#${target}` }, unit: null,
      provenance: "deterministic", evidence: { kind: "ifc", expressId: id, attribute, relationshipId: id } });
  }
  expect(result.entities.find(e => e.key === "#70")).toEqual({ key: "#70", kind: "IFCRELSPACEBOUNDARY", name: "Declared", globalId: "boundary" });
  for (const [id, declaration] of [[70, "INTERNAL"], [72, "EXTERNAL"], [76, "INTERNAL"]] as const) {
    expect(fact(id, "InternalOrExternalBoundary").value).toEqual({ type: "text", value: declaration });
    expect(fact(id, "InternalOrExternalBoundary").evidence).toEqual({ kind: "ifc", expressId: id, attribute: "InternalOrExternalBoundary", relationshipId: id });
    expect(fact(id, "PhysicalOrVirtualBoundary").value).toEqual({ type: "text", value: "PHYSICAL" });
  }
  expect(fact(73, "PhysicalOrVirtualBoundary").value).toEqual({ type: "text", value: "VIRTUAL" });
  expect(fact(73, "RelatedBuildingElement").value).toEqual({ type: "structured", value: null });
  expect(fact(73, "RelatingSpace").value).toEqual({ type: "reference", value: "#60" });
  expect(result.facts.filter(f => f.predicate === "InternalOrExternalBoundary")).toHaveLength(5);
  for (const f of result.facts) expect(sourceFactInput.safeParse(f).success).toBe(true);
  expect(await extractIfcModel(bytes)).toEqual(result);
});

for (const schema of ["IFC4", "IFC2X3"]) test(`${schema}: material declarations and precise units survive unrelated currency`, async () => {
  const bytes = new TextEncoder().encode(new TextDecoder().decode(fixture(schema))
    .replace("(#2,#3)", "(#2,#3,#80,#84)")
    .replace("(#20,#21,#22,#23,#24,#25)", "(#20,#21,#22,#23,#24,#25,#85,#86)")
    .replace("#50=", `
#80=IFCMONETARYUNIT(${schema === "IFC4" ? "'EUR'" : ".EUR."});
#81=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);
#82=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#83=IFCDERIVEDUNITELEMENT(#81,1);
#84=IFCDERIVEDUNIT((#83,#87),.MASSDENSITYUNIT.,$);
#85=IFCPROPERTYSINGLEVALUE('Label',$,IFCLABEL('not a currency'),$);
#86=IFCPROPERTYSINGLEVALUE('Integer',$,IFCINTEGER(7),$);
#87=IFCDERIVEDUNITELEMENT(#82,-1);
#90=IFCMATERIAL('Declared material'${schema === "IFC4" ? ",$,$" : ""});
#91=IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(0.),$);
#92=${schema === "IFC4" ? "IFCMATERIALPROPERTIES('Pset_MaterialCommon',$,(#91,#95),#90)" : "IFCEXTENDEDMATERIALPROPERTIES(#90,(#91,#95),$,'Pset_MaterialCommon')"};
#93=IFCRELASSOCIATESMATERIAL('material-assignment',$,$,$,(#10),#90);
#94=IFCRELAGGREGATES('component-membership',$,$,$,#10,(#96));
#95=IFCPROPERTYSINGLEVALUE('ExplicitDensity',$,IFCMASSDENSITYMEASURE(500.),#84);
#96=IFCBUILDINGELEMENTPART('component',$,'Component',$,$,$,$,$${schema === "IFC4" ? ",.NOTDEFINED." : ""});
#50=`));
  const result = await extractIfcModel(bytes);
  const fact = (entity: number, predicate: string) => result.facts.find(f => f.entityKey === `#${entity}` && f.predicate === predicate)!;
  expect(result.entities.find(e => e.key === "#90")).toEqual({ key: "#90", kind: "IFCMATERIAL", name: "Declared material" });
  expect(result.entities.find(e => e.key === "#93")).toMatchObject({ kind: "IFCRELASSOCIATESMATERIAL", globalId: "material-assignment" });
  expect(fact(93, "RelatingMaterial")).toMatchObject({ kind: "relationship", value: { type: "reference", value: "#90" }, evidence: { expressId: 93, relationshipId: 93, attribute: "RelatingMaterial" } });
  expect(fact(93, "RelatedObjects")).toMatchObject({ value: { type: "structured", value: [{ reference: "#10" }] }, evidence: { expressId: 93, relationshipId: 93, attribute: "RelatedObjects" } });
  expect(fact(92, "Material").value).toEqual({ type: "reference", value: "#90" });
  expect(fact(90, "material.Pset_MaterialCommon.MassDensity")).toEqual({
    entityKey: "#90", predicate: "material.Pset_MaterialCommon.MassDensity", kind: "property", value: { type: "number", value: 0 },
    unit: expect.objectContaining({ source: "project-default", ambiguous: false, candidates: [expect.objectContaining({ expressID: 84, UnitType: { type: 3, value: "MASSDENSITYUNIT" }, Elements: [{ reference: "#83" }, { reference: "#87" }] })] }),
    provenance: "deterministic", evidence: { kind: "ifc", expressId: 91, attribute: "NominalValue", dataType: "IFCMASSDENSITYMEASURE" },
  });
  expect(fact(90, "material.Pset_MaterialCommon.ExplicitDensity")).toMatchObject({ value: { type: "number", value: 500 }, unit: { source: "explicit", expressId: 84 }, evidence: { expressId: 95, dataType: "IFCMASSDENSITYMEASURE" } });
  for (const p of ["Label", "Boolean", "Integer", "Unknown"]) expect(fact(10, `instance.Instance.${p}`).unit).toBeNull();
  expect(fact(10, "Name").unit).toBeNull();
  expect(fact(10, "instance.Declared.Area").unit).toMatchObject({ source: "project-default", candidates: [expect.objectContaining({ expressID: 3 })] });
  expect(fact(10, "instance.Instance.Default").unit).toMatchObject({ source: "project-default", candidates: [expect.objectContaining({ expressID: 2 })] });
  expect(fact(10, "instance.Instance.Explicit").unit).toMatchObject({ source: "explicit", expressId: 5 });
  expect(fact(96, "decomposes")).toMatchObject({ value: { type: "reference", value: "#10" }, evidence: { expressId: 94, relationshipId: 94 } });
  for (const f of result.facts) expect(sourceFactInput.safeParse(f).success).toBe(true);
  expect(await extractIfcModel(bytes)).toEqual(result);
});

test("IFC4: material layer, constituent and profile references remain declarations, not inferred geometry", async () => {
  const bytes = new TextEncoder().encode(new TextDecoder().decode(fixture()).replace("#50=", `
#100=IFCMATERIAL('Material',$,$);
#101=IFCMATERIALLAYER(#100,0.025,.F.,'Board',$,$,$);
#102=IFCMATERIALLAYERSET((#101),'Layers',$);
#103=IFCMATERIALLAYERSETUSAGE(#102,.AXIS2.,.NEGATIVE.,0.,$);
#104=IFCMATERIALCONSTITUENT('Constituent',$,#100,0.5,$);
#105=IFCMATERIALCONSTITUENTSET('Constituents',$,(#104));
#106=IFCMATERIALPROFILE('Profile',$,#100,#110,$,$);
#107=IFCMATERIALPROFILESET('Profiles',$,(#106),$);
#108=IFCMATERIALPROFILESETUSAGE(#107,5,$);
#110=IFCRECTANGLEPROFILEDEF(.AREA.,'Geometry not traversed',$,0.1,0.2);
#120=IFCRELASSOCIATESMATERIAL('layers',$,$,$,(#10),#103);
#121=IFCRELASSOCIATESMATERIAL('constituents',$,$,$,(#12),#105);
#122=IFCRELASSOCIATESMATERIAL('profiles',$,$,$,(#10),#108);
#50=`));
  const result = await extractIfcModel(bytes);
  const fact = (entity: number, predicate: string) => result.facts.find(f => f.entityKey === `#${entity}` && f.predicate === predicate)!;
  expect(fact(103, "ForLayerSet").value).toEqual({ type: "reference", value: "#102" });
  expect(fact(102, "MaterialLayers").value).toEqual({ type: "structured", value: [{ reference: "#101" }] });
  expect(fact(101, "LayerThickness")).toMatchObject({ value: { type: "number", value: 0.025 }, evidence: { expressId: 101, attribute: "LayerThickness", dataType: "IFCNONNEGATIVELENGTHMEASURE" }, unit: { source: "project-default" } });
  expect(fact(105, "MaterialConstituents").value).toEqual({ type: "structured", value: [{ reference: "#104" }] });
  expect(fact(104, "Fraction").unit).toBeNull();
  expect(fact(108, "ForProfileSet").value).toEqual({ type: "reference", value: "#107" });
  expect(fact(107, "MaterialProfiles").value).toEqual({ type: "structured", value: [{ reference: "#106" }] });
  expect(fact(106, "Profile").value).toEqual({ type: "reference", value: "#110" });
  expect(result.entities.some(e => e.key === "#110")).toBe(false);
  expect(result.entities.filter(e => e.key === "#100")).toHaveLength(1);
  for (const f of result.facts) expect(sourceFactInput.safeParse(f).success).toBe(true);
});

test("detection and honest rejection", async () => {
  expect(isIfcSource("application/octet-stream", "MODEL.IFC")).toBe(true);
  expect(isIfcSource("application/x-ifc; charset=utf-8", "model")).toBe(true);
  expect(isIfcSource("text/plain", "model.ifczip")).toBe(false);
  await expect(extractIfcModel(new TextEncoder().encode("not IFC"))).rejects.toThrow();
  const broken = new TextDecoder().decode(fixture()).replace("(#20,#21,#22,#23,#24,#25)", "(#777)");
  await expect(extractIfcModel(new TextEncoder().encode(broken))).rejects.toThrow();
  await expect(extractIfcModel(fixture("IFC4X3"))).rejects.toThrow();
});
