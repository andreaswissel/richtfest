import { expect, test } from "bun:test";
import { searchAddresses } from "./address-search";

test("address search returns complete addresses with coordinates and retained source attribution, not centroids", async () => {
  const building = {
    street: "Giersstraße",
    housenumber: "20a",
    postcode: "13088",
    city: "Berlin",
    country_code: "de",
    place_id: "a",
    lon: 13.4826,
    lat: 52.5575,
    result_type: "building",
    datasource: { attribution: "© OpenStreetMap contributors" },
  };
  const fetcher = async () =>
    Response.json({
      results: [
        building,
        building,
        { ...building, place_id: "street", result_type: "street" },
        { ...building, place_id: "no-number", housenumber: undefined },
        { ...building, place_id: "blank-number", housenumber: " " },
        { ...building, place_id: "bad-coordinates", lat: 95 },
        { ...building, place_id: "unattributed", datasource: {} },
        {
          ...building,
          place_id: "village",
          city: undefined,
          village: "Wandlitz",
          street: "Dorfstraße",
          housenumber: "7",
          lon: 13.45,
          lat: 52.75,
        },
      ],
    });
  expect(
    await searchAddresses("test-key", "Giersstrasse 20", "de", fetcher),
  ).toEqual([
    {
      street: "Giersstraße 20a",
      postalCode: "13088",
      city: "Berlin",
      country: "DE",
      addressReference: {
        provider: "geoapify",
        placeId: "a",
        longitude: 13.4826,
        latitude: 52.5575,
        attribution: "Powered by Geoapify · © OpenStreetMap contributors",
      },
    },
    {
      street: "Dorfstraße 7",
      postalCode: "13088",
      city: "Wandlitz",
      country: "DE",
      addressReference: {
        provider: "geoapify",
        placeId: "village",
        longitude: 13.45,
        latitude: 52.75,
        attribution: "Powered by Geoapify · © OpenStreetMap contributors",
      },
    },
  ]);
});

test("address search errors never expose credentials or upstream bodies", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("https://api.geoapify.com/?apiKey=private-key");
    },
    async () => new Response("private-key", { status: 429 }),
    async () => Response.json({ unexpected: "private-key" }),
  ]) {
    try {
      await searchAddresses("private-key", "Berlin 20", "en", fetcher);
      throw new Error("Expected failure");
    } catch (error: any) {
      expect(error.status).toBe(502);
      expect(error.message).toBe(
        "Address search unavailable; retry or enter the address manually",
      );
    }
  }
});
