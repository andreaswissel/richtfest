import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ComponentDetail, ComponentRecord } from "@richtfest/shared";
import { Components, ComponentDetailScreen } from "../src/screens/components";
import { queryClient } from "../src/query";

const record: ComponentRecord = {
  id: "product",
  revisionId: "current",
  revision: 2,
  reviewVersion: 0,
  reviewStatus: "unreviewed",
  reviewNote: null,
  reviewedAt: null,
  createdAt: "2026-10-13",
  data: {
    key: "sample",
    name: "Sample slab",
    manufacturer: "Supplier",
    category: "floor_slab",
    prefabrication: "semi_precast",
    scopeNote: "Plate only, not the completed floor.",
    sources: [
      {
        id: "pdf",
        title: "Technical evidence",
        url: "https://example.com/evidence.pdf",
        edition: "2026",
        retrievedOn: "2026-10-13",
        sha256: "a".repeat(64),
        pages: 4,
        note: "Supplier declaration.",
      },
    ],
    facts: [
      {
        property: "slab_thickness",
        value: 200,
        unit: "mm",
        conditions:
          "Only with topping and temporary support; never an unconditional span.",
        sourceId: "pdf",
        page: 3,
      },
    ],
    warnings: ["Requires structural verification."],
  },
};
function render(url: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/components" element={<Components />} />
          <Route path="/components/:id" element={<ComponentDetailScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function detail(documents: ComponentDetail["documents"] = []) {
  queryClient.setQueryData(["/components/product"], {
    component: record,
    history: [{ ...record, revisionId: "archived", revision: 1 }],
    documents,
    canImport: true,
    canReview: true,
  } satisfies ComponentDetail);
}
afterEach(() => queryClient.clear());

test("catalog selection is a filter-preserving link and inspector retains complete conditions", () => {
  queryClient.setQueryData(
    ["/components?q=Sample&category=&reviewStatus=&offset=0"],
    { items: [record], nextOffset: null, canImport: true, canReview: true },
  );
  const html = render("/components?q=Sample&selected=product");
  expect(html).toContain("/components?q=Sample&amp;selected=product");
  expect(html).toContain('href="/components/product"');
  expect(html).toContain(record.data.facts[0].conditions!);
  expect(html).toContain("Slab thickness");
  expect(html).toContain("200 mm");
  expect(html).not.toContain('type="file"');
});
test("saved PDF matches fingerprint, citation page and revision, with original and fallback links", () => {
  detail([
    {
      id: "stored",
      sha256: "a".repeat(64),
      pages: 4,
      sizeBytes: 100,
      createdAt: "2026-10-13",
    },
  ]);
  const html = render("/components/product?source=pdf&page=3");
  expect(html).toContain("<iframe");
  expect(html).toContain(
    "/api/components/product/revisions/current/sources/pdf/pdf#page=3",
  );
  expect(html).toContain("Open saved PDF");
  expect(html).toContain("Open original supplier link");
  expect(html.indexOf("Review decision")).toBeGreaterThan(
    html.indexOf("Only with topping"),
  );
  expect(render("/components/product")).toContain("/sources/pdf/pdf#page=3");
  expect(render("/components/product?page=999")).toContain(
    "/sources/pdf/pdf#page=4",
  );
});
test("missing and unmatched snapshots are honest; only current fingerprinted records offer upload", () => {
  detail([
    {
      id: "wrong",
      sha256: "b".repeat(64),
      pages: 4,
      sizeBytes: 100,
      createdAt: "2026-10-13",
    },
  ]);
  const current = render("/components/product");
  expect(current).not.toContain("<iframe");
  expect(current).toContain("PDF snapshot not yet attached");
  expect(current).toContain('accept=".pdf,application/pdf"');
  detail([
    {
      id: "wrong-pages",
      sha256: "a".repeat(64),
      pages: 2,
      sizeBytes: 100,
      createdAt: "2026-10-13",
    },
  ]);
  expect(render("/components/product")).not.toContain("<iframe");
  const historical = render("/components/product?revision=archived");
  expect(historical).not.toContain('type="file"');
  expect(historical).not.toContain("<textarea");
});
test("historical snapshot resolves archived fingerprint and sources without fingerprints are link-only", () => {
  detail([
    {
      id: "stored",
      sha256: "a".repeat(64),
      pages: 4,
      sizeBytes: 100,
      createdAt: "2026-10-13",
    },
  ]);
  expect(render("/components/product?revision=archived&page=3")).toContain(
    "/api/components/product/revisions/archived/sources/pdf/pdf#page=3",
  );
  const external = {
    ...record,
    data: {
      ...record.data,
      sources: [{ ...record.data.sources[0], sha256: null, pages: null }],
    },
  };
  queryClient.setQueryData(["/components/product"], {
    component: external,
    history: [],
    documents: [],
    canImport: true,
    canReview: false,
  });
  const html = render("/components/product");
  expect(html).toContain("External source only");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain('type="file"');
});
