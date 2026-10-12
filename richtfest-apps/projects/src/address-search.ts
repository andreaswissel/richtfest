import { z } from "zod";
import {
  addressReferenceInput,
  projectAddressInput,
  type AddressSuggestion,
} from "@richtfest/shared";
import { boundedBody } from "./location-context";

const resultInput = z.object({
  street: z.string().trim().min(1),
  housenumber: z.string().trim().min(1),
  postcode: z.string().optional(),
  city: z.string().optional(),
  town: z.string().optional(),
  village: z.string().optional(),
  country_code: z.string().length(2),
  place_id: z.string(),
  lon: z.number(),
  lat: z.number(),
  result_type: z.literal("building"),
  datasource: z.object({ attribution: z.string().min(1) }),
});

/** No POIs or street/city centroids masquerading as a complete site address. */
export async function searchAddresses(
  apiKey: string,
  text: string,
  language: "en" | "de",
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<AddressSuggestion[]> {
  const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
  url.search = new URLSearchParams({
    text,
    lang: language,
    format: "json",
    limit: "5",
    bias: "countrycode:de",
    apiKey,
  }).toString();
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Upstream unavailable");
    const body = z
      .object({ results: z.array(z.unknown()) })
      .parse(JSON.parse((await boundedBody(response, 250_000)).toString()));
    const suggestions: AddressSuggestion[] = [];
    for (const result of body.results) {
      const parsed = resultInput.safeParse(result);
      if (!parsed.success) continue;
      const p = parsed.data;
      const address = projectAddressInput.safeParse({
        street: `${p.street} ${p.housenumber}`,
        postalCode: p.postcode ?? null,
        city: p.city ?? p.town ?? p.village,
        country: p.country_code.toUpperCase(),
      });
      const reference = addressReferenceInput.safeParse({
        provider: "geoapify",
        placeId: p.place_id,
        longitude: p.lon,
        latitude: p.lat,
        attribution: `Powered by Geoapify · ${p.datasource.attribution}`,
      });
      if (!address.success || !address.data.city || !reference.success)
        continue;
      if (!suggestions.some((s) => s.addressReference.placeId === p.place_id))
        suggestions.push({ ...address.data, addressReference: reference.data });
    }
    return suggestions;
  } catch {
    // Provider errors can include the URL (and credential). Never forward them.
    throw Object.assign(
      new Error(
        "Address search unavailable; retry or enter the address manually",
      ),
      { status: 502, code: "address_search_unavailable" },
    );
  }
}
