import { StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LocationContext } from "@richtfest/shared";
import { useSiteWorkbench } from "../src/components/location/site-workbench";

/** In Vite: import('/tests/location-imagery.browser.tsx').then(m => m.testSiteImages()). */
export async function testSiteImages() {
  const projectId = "image-lifetime-fixture";
  const path = `/projects/${projectId}`;
  const context: LocationContext = {
    siteId: "berlin-image-fixture", address: "Image fixture", origin: [0, 0],
    longitude: 13, latitude: 52, radius: 100, buildings: [], trees: [], sources: [], importedAt: "2026-10-18",
  };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/auth/me"], { permissions: [] });
  client.setQueryData([`${path}/location`], { context });
  client.setQueryData([`${path}/building-model/site-plan`], { pages: [] });
  client.setQueryData([`${path}/noise-sources`], { sources: [], survey: null });
  const colours = ["#ed2317", "#1bc438", "#2647db"];
  const pixels = [[237, 35, 23], [27, 196, 56], [38, 71, 219]];
  const source = document.createElement("canvas");
  source.width = source.height = 2;
  const ctx = source.getContext("2d")!;
  const blobs = await Promise.all(colours.map(async (colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 2, 2);
    return new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!)));
  }));
  const originalFetch = window.fetch;
  const endpoints = ["aerial/near", "aerial/far", "rail-noise"];
  window.fetch = (input, init) => {
    const url = new URL(String(input), window.location.href);
    const index = endpoints.findIndex((endpoint) => url.pathname === `/api${path}/location/${endpoint}`);
    if (index >= 0 && !url.searchParams.has("v")) throw new Error("Imagery HTTP URL must be versioned");
    return index < 0 ? originalFetch(input, init) : Promise.resolve(new Response(blobs[index]));
  };
  function Images() {
    const site = useSiteWorkbench({ projectId, context, layers: { aerial: true, railNoise: true, roads: false, plan: false }, tool: "select", setTool: () => {} });
    useEffect(() => site.onZoom(true), []);
    return <>{[site.overlay.aerial.near, site.overlay.aerial.far, site.overlay.railNoise].map((url, i) =>
      url ? <img key={i} alt={endpoints[i]} src={url} /> : null,
    )}</>;
  }
  const host = document.createElement("div");
  host.hidden = true;
  document.body.append(host);
  let root: Root | undefined;
  try {
    // Reopening a viewer must decode the same cached images, not revoked object URLs.
    for (let visit = 0; visit < 3; visit++) {
      root = createRoot(host);
      root.render(<StrictMode><QueryClientProvider client={client}><Images /></QueryClientProvider></StrictMode>);
      const deadline = performance.now() + 5000;
      while (host.querySelectorAll("img").length !== 3) {
        if (performance.now() > deadline) throw new Error(`Images did not appear on visit ${visit + 1}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const images = [...host.querySelectorAll("img")];
      for (const [index, image] of images.entries()) {
        await image.decode();
        ctx.clearRect(0, 0, 2, 2);
        ctx.drawImage(image, 0, 0);
        const pixel = [...ctx.getImageData(0, 0, 1, 1).data];
        if (pixel.slice(0, 3).some((channel, c) => channel !== pixels[index][c]) || pixel[3] !== 255)
          throw new Error(`${endpoints[index]} lost its image on visit ${visit + 1}: ${pixel}`);
      }
      root.unmount();
      root = undefined;
    }
    return { visits: 3, decodedImages: 9, checks: "near/far aerial and rail noise retain their pixels across remounts and StrictMode effect replay" };
  } finally {
    root?.unmount();
    host.remove();
    client.clear();
    window.fetch = originalFetch;
  }
}
