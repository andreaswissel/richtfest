import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locateAddressPoint, municipalityCandidates, nominatimGeocoder, normalHouse, normalStreet, parcelAddresses, parseStreetAddress, stateAt, statesNear, streetPattern, type AddressHit, type AddressPointResolver } from "./address-points";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "test-fixtures/address-points", name), "utf8");
const signal = () => new AbortController().signal;
let upstream: ReturnType<typeof spyOn> | null = null;
afterEach(() => { upstream?.mockRestore(); upstream = null; });
const mockFetch = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) => {
  upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new URL(String(input)), init), { preconnect: fetch.preconnect }));
  return upstream;
};
/** The LIKE pattern as a regular expression, for checking which register spellings it fetches (case-insensitive services). */
const patternRegex = (street: string) => new RegExp(`^${[...streetPattern(street)].map(c => c === "\u0001" ? ".*" : c === "\u0002" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`, "i");

test("street names compare across Str./Straße, ß/ss, umlauts, hyphens and Sankt, but not across different streets", () => {
  for (const [a, b] of [["Hohe Str.", "Hohe Straße"], ["hohe strasse", "Hohe Straße"], ["Moenckebergstrasse", "Mönckebergstraße"], ["Friedrich-Ebert-Str.", "Friedrich Ebert Straße"],
    ["Sankt Johanner Markt", "St. Johanner Markt"], ["Giersstrasse", "Giersstraße"], ["Straße des 17. Juni", "Str. des 17. Juni"]])
    expect(normalStreet(a)).toBe(normalStreet(b));
  for (const [a, b] of [["Giersstraße", "Gierstraße"], ["Königstraße", "Kleine Königstraße"], ["Am Markt", "Markt"], ["Hauptstraße", "Hauptweg"], ["Strandweg", "Str. Andweg"]])
    expect(normalStreet(a)).not.toBe(normalStreet(b));
  // The fetch pattern finds every spelling the comparison accepts, including the abbreviated NRW register form.
  for (const [typed, stored] of [["Hohe Straße", "Hohe Str."], ["Hohe Str.", "Hohe Straße"], ["moenckebergstrasse", "Mönckebergstraße"], ["St. Johanner Markt", "St. Johanner Markt"], ["Sankt Johanner Markt", "St. Johanner Markt"], ["Friedrich Ebert Str 79".replace(" 79", ""), "Friedrich-Ebert-Straße"]])
    expect(patternRegex(typed).test(stored)).toBe(true);
  expect(streetPattern("O'Brien*Weg%")).not.toMatch(/['*%]/);
});

test("house numbers parse strictly: one number, optional letter or /n suffix, no ranges", () => {
  expect(parseStreetAddress("Hauptstr. 5 a")).toEqual({ street: "Hauptstr.", number: 5, suffix: "a", houseKey: "5a" });
  expect(parseStreetAddress("Königstraße 12/1")?.houseKey).toBe("12/1");
  expect(parseStreetAddress("Straße 101 12")).toMatchObject({ street: "Straße 101", number: 12 });
  for (const value of ["Hauptstraße 12-14", "Am Markt", "12", "Hauptstraße 0"]) expect(parseStreetAddress(value)).toBeNull();
  expect(normalHouse("118 A")).toBe("118a");
  expect(parcelAddresses("Breiter Weg 172, 173; Ernst-Reuter-Allee 19; Ulrichplatz 1, 2 A")).toEqual([["Breiter Weg", "172"], ["Breiter Weg", "173"], ["Ernst-Reuter-Allee", "19"], ["Ulrichplatz", "1"], ["Ulrichplatz", "2a"]]);
});

test("municipality names map to official keys and candidate states", async () => {
  const states = async (city: string) => (await municipalityCandidates(city)).map(m => `${m.state}:${m.name}`).sort();
  expect(await states("Frankfurt")).toEqual(["BB:Frankfurt (Oder)", "HE:Frankfurt am Main"]);
  expect(await states("Frankfurt am Main")).toEqual(["HE:Frankfurt am Main"]);
  expect(await states("Frankfurt/Main")).toEqual(["HE:Frankfurt am Main"]);
  expect(await states("Halle/Saale")).toEqual(["ST:Halle (Saale)"]);
  expect(await states("Halle")).toContain("ST:Halle (Saale)");
  expect(await states("Berlin-Mitte")).toEqual(["BE:Berlin"]);
  expect(await states("Sankt Ingbert")).toEqual(["SL:St. Ingbert"]);
  expect(await states("Hallenberg")).toEqual(["NW:Hallenberg"]);
  expect((await municipalityCandidates("Köln"))[0]).toEqual({ ags: "05315000", name: "Köln", state: "NW" });
  expect(await states("Xyzdorf")).toEqual([]);
});

test("state areas: inside, near a border, and outside Germany", async () => {
  expect(await stateAt(13.057776, 52.405458)).toBe("BB"); // Potsdam
  expect(await stateAt(13.482668, 52.557547)).toBe("BE"); // Berlin-Weißensee
  expect(await stateAt(8.2743, 49.9990)).toBe("RP"); // Mainz, across the Rhine from Hessen
  expect(await stateAt(8.2840, 50.0080)).toBe("HE"); // Mainz-Kastel, administratively Wiesbaden
  expect(await stateAt(2.35, 48.85)).toBeNull();
  // On the Danube between Ulm (BW) and Neu-Ulm (BY) both states are within the simplification margin; inland only one.
  expect((await statesNear(9.9960, 48.3955)).sort()).toEqual(["BW", "BY"]);
  expect(await statesNear(10.0106, 48.3929)).toEqual(["BY"]);
});

const point = (longitude: number, latitude: number, id: string): AddressHit => ({ siteId: id, address: id, longitude, latitude, precision: "house", sourceUrl: `https://example.test/${id}`, body: "{}", responses: [{ url: `https://example.test/${id}`, body: "{}" }] });
const register = (hits: AddressHit[] | Error, seen?: string[]): AddressPointResolver => ({ attribution: "test", resolve: async query => { seen?.push(query.municipalities.map(m => m.ags).join(",")); if (hits instanceof Error) throw hits; return hits; } });
const frankfurtMain = point(8.680531, 50.110858, "he"), frankfurtOder = point(14.5523, 52.3423, "bb");

test("a municipality name shared by two states resolves by the geocoded point, asymmetrically", async () => {
  const address = { street: "Paulsplatz 9", postalCode: "60311", city: "Frankfurt" };
  // Brandenburg's register returns a point that lies in Hessen: it cannot be a Brandenburg address and is dropped.
  const seen: string[] = [];
  const wrongSide = await locateAddressPoint(address, signal(), { registers: { HE: register([frankfurtMain], seen), BB: register([{ ...frankfurtMain, siteId: "bb-wrong" }], seen) } });
  expect(wrongSide.point).toMatchObject({ state: "HE", siteId: "he", precision: "house", attribution: "test" });
  expect(seen.sort()).toEqual(["06412000", "12053000"]);
  // The reverse: only the Brandenburg hit lies in its own state.
  const oder = await locateAddressPoint(address, signal(), { registers: { HE: register([{ ...frankfurtOder, siteId: "he-wrong" }]), BB: register([frankfurtOder]) } });
  expect(oder.point).toMatchObject({ state: "BB", siteId: "bb" });
  // Both genuine: never pick one silently.
  await expect(locateAddressPoint(address, signal(), { registers: { HE: register([frankfurtMain]), BB: register([frankfurtOder]) } })).rejects.toMatchObject({ code: "environment_address_ambiguous" });
  // One register unavailable: the other state's hit is not trusted either.
  await expect(locateAddressPoint(address, signal(), { registers: { HE: register([frankfurtMain]), BB: register(Object.assign(new Error("down"), { code: "environment_source_unavailable" })) } })).rejects.toThrow("down");
  // Distant duplicates inside one state are ambiguous too.
  await expect(locateAddressPoint(address, signal(), { registers: { HE: register([frankfurtMain, point(8.70, 50.13, "he-2")]), BB: register([]) } })).rejects.toThrow("distant");
  const none = await locateAddressPoint(address, signal(), { registers: { HE: register([]), BB: register([]) } });
  expect(none).toMatchObject({ point: null, reason: "not_found", states: ["BB", "HE"] });
  expect(none.point ? "" : none.message).toContain("Hessen");
});

test("states without an open register report it, use only the configured fallback, and every miss lists the covered states", async () => {
  const munich = { street: "Marienplatz 8", city: "München" };
  const unsupported = await locateAddressPoint(munich, signal(), { registers: {} });
  expect(unsupported).toMatchObject({ point: null, reason: "no_open_service", states: ["BY"] });
  expect(unsupported.point ? "" : unsupported.message).toContain("Site address points are available for Baden-Württemberg, Berlin, Brandenburg, Bremen, Hamburg, Hessen, Niedersachsen, Nordrhein-Westfalen, Rheinland-Pfalz, Saarland, Sachsen, Sachsen-Anhalt, Thüringen.");
  const fallback = register([point(11.575489, 48.137474, "osm")]);
  expect((await locateAddressPoint(munich, signal(), { registers: {}, fallback })).point).toMatchObject({ state: "BY", siteId: "osm" });
  // A state with a register never falls back.
  const seen: string[] = [];
  expect((await locateAddressPoint({ street: "Domkloster 4", city: "Köln" }, signal(), { registers: { NW: register([]) }, fallback: register([point(6.957, 50.941, "osm")], seen) })).reason).toBe("not_found");
  expect(seen).toEqual([]);
  for (const [address, reason] of [[{ street: "Hauptstraße 12-14", city: "Köln" }, "invalid_address"], [{ street: "Hauptstraße 1", city: "Wien", country: "AT" }, "outside_germany"], [{ street: "Hauptstraße 1", city: "Xyzdorf" }, "municipality_not_found"]] as const) {
    const result = await locateAddressPoint(address, signal(), { registers: { NW: register([]) } });
    expect(result).toMatchObject({ point: null, reason });
    expect(result.point ? "" : result.message).toContain("Site address points are available for");
  }
});

test("recorded NRW GebRef (OGC API, CQL2): abbreviated register street, encoded filter", async () => {
  const calls = mockFetch(url => {
    expect(url.origin).toBe("https://ogc-api.nrw.de");
    expect(url.search).not.toContain("+");
    expect(url.searchParams.get("filter")).toBe("((regbezschl='3' AND kreisschl='15' AND gmdschl='000')) AND hnr='52' AND CASEI(str) LIKE CASEI('_ohe%_tr%')");
    return new Response(fixture("nw-gebref.json"));
  });
  const result = await locateAddressPoint({ street: "Hohe Straße 52", city: "Köln" }, signal());
  expect(result.point).toMatchObject({ state: "NW", siteId: "nw-gebref:DENW37HK1000qz46", address: "Hohe Str. 52, Köln", precision: "house", latitude: 50.93648606550008, longitude: 6.956373384093922 });
  expect(result.point!.attribution).toContain("dl-de/zero-2-0");
  expect(calls).toHaveBeenCalledTimes(1);
  // Same response, other house number: nothing nearby is substituted.
  expect((await locateAddressPoint({ street: "Hohe Straße 52a", city: "Köln" }, signal())).reason).toBe("not_found");
});

test("recorded Brandenburg Hauskoordinaten (deegree WFS, FES): postal code must agree", async () => {
  mockFetch(url => {
    expect(url.hostname).toBe("isk.geobasis-bb.de");
    expect(url.searchParams.get("FILTER")).toContain("<fes:Literal>12054000</fes:Literal>");
    return new Response(fixture("bb-hauskoordinaten.xml"));
  });
  const result = await locateAddressPoint({ street: "Friedrich-Ebert-Str. 79", postalCode: "14469", city: "Potsdam" }, signal());
  expect(result.point).toMatchObject({ state: "BB", address: "Friedrich-Ebert-Straße 79, 14469 Potsdam", precision: "house", latitude: 52.405458, longitude: 13.057776 });
  expect((await locateAddressPoint({ street: "Friedrich-Ebert-Straße 79", postalCode: "14467", city: "Potsdam" }, signal())).reason).toBe("not_found");
});

test("recorded Niedersachsen ALKIS chain: street catalogue, address, addressed building", async () => {
  const requests: string[] = [];
  mockFetch((url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("AX_LagebezeichnungKatalogeintrag")) { requests.push("catalogue"); return new Response(fixture("ni-katalogeintrag.xml")); }
    if (body.includes("AX_LagebezeichnungMitHausnummer")) { requests.push("address"); expect(body).toContain("<fes:Literal>00841</fes:Literal>"); return new Response(fixture("ni-lagebezeichnung.xml")); }
    expect(url.searchParams.get("RESOURCEID")).toBe("DENIAL4300009WwM");
    requests.push("building"); return new Response(fixture("ni-gebaeude.xml"));
  });
  const result = await locateAddressPoint({ street: "Ernst-August-Platz 1", city: "Hannover" }, signal());
  expect(requests).toEqual(["catalogue", "address", "building"]);
  expect(result.point).toMatchObject({ state: "NI", siteId: "ni-alkis:DENIAL430000b3oC", address: "Ernst-August-Platz 1, Hannover", precision: "building" });
  expect(result.point!.latitude).toBeCloseTo(52.3763, 3);
  expect(result.point!.longitude).toBeCloseTo(9.7414, 3);
  expect(result.point!.responses).toHaveLength(3);
  // 10A..10D are in the same response; "10" is not.
  expect((await locateAddressPoint({ street: "Ernst-August-Platz 10", city: "Hannover" }, signal())).reason).toBe("not_found");
});

test("recorded Sachsen-Anhalt ALKIS vereinfacht: parcels whose address list contains the house", async () => {
  mockFetch(() => new Response(fixture("st-flurstuecke.xml")));
  const result = await locateAddressPoint({ street: "Breiter Weg 173", city: "Magdeburg" }, signal());
  expect(result.point).toMatchObject({ state: "ST", address: "Breiter Weg 173, Magdeburg", precision: "parcel" });
  expect(result.point!.siteId).toBe("st-alkis-flurstueck:150938145030100001__+1");
  expect((await locateAddressPoint({ street: "Ulrichplatz 2", city: "Magdeburg" }, signal())).point?.address).toBe("Ulrichplatz 2, Magdeburg");
  expect((await locateAddressPoint({ street: "Breiter Weg 17", city: "Magdeburg" }, signal())).reason).toBe("not_found");
});

test("recorded Nominatim fallback: identifying user agent, exact house number only", async () => {
  const agents: string[] = [];
  mockFetch((url, init) => {
    expect(url.origin + url.pathname).toBe("https://nominatim.example/search");
    agents.push(new Headers(init?.headers).get("user-agent") ?? "");
    return new Response(fixture("nominatim-by.json"));
  });
  const fallback = nominatimGeocoder({ url: "https://nominatim.example/", userAgent: "Richtfest/test" });
  const result = await locateAddressPoint({ street: "Marienplatz 8", postalCode: "80331", city: "München" }, signal(), { fallback });
  expect(result.point).toMatchObject({ state: "BY", precision: "approximate", address: "Marienplatz 8, 80331 München" });
  expect(result.point!.attribution).toContain("OpenStreetMap contributors, ODbL");
  expect(agents).toEqual(["Richtfest/test"]);
  // The recorded results are all number 8: a request for 9 gets nothing nearby.
  expect((await locateAddressPoint({ street: "Marienplatz 9", postalCode: "80331", city: "München" }, signal(), { fallback })).reason).toBe("not_found");
});
