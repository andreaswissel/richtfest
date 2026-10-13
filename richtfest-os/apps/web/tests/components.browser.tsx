import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { RowLink, Table } from "../src/components/ui/primitives";
import "../src/screens/components.css";

/** Run through Vite: import('/tests/components.browser.tsx').then(m => m.testComponentRowLinks()) */
export async function testComponentRowLinks() {
  const host = document.createElement("div");
  host.className = "components-screen";
  host.style.cssText = "position:fixed;inset:0;z-index:9999;background:white";
  document.body.append(host);
  const root = createRoot(host);
  const previousDensity = document.documentElement.dataset.density;
  function Catalog() {
    const location = useLocation();
    return (
      <>
        <Table
          headers={["Name", "Category", "Review"]}
          rows={["window", "slab"].map((id) => ({
            id,
            cells: [
              <div>
                <RowLink to={`/components?q=supplier&selected=${id}`}>
                  {id}
                </RowLink>
                <div>Supplier</div>
              </div>,
              id === "window" ? "Window system" : "Floor slab",
              "Unreviewed",
            ],
          }))}
        />
        <output>{location.pathname + location.search}</output>
      </>
    );
  }
  try {
    flushSync(() =>
      root.render(
        <MemoryRouter>
          <Catalog />
        </MemoryRouter>,
      ),
    );
    for (const density of ["dense", "normal"]) {
      document.documentElement.dataset.density = density;
      const rows = host.querySelectorAll("tbody tr");
      for (const [index, row] of Array.from(rows).entries()) {
        const expected = `/components?q=supplier&selected=${index === 0 ? "window" : "slab"}`;
        for (const cell of row.querySelectorAll("td")) {
          const rect = cell.getBoundingClientRect();
          // Hit-test both cell content and empty padding, not a synthetic td.click().
          for (const [x, y] of [
            [rect.x + rect.width / 2, rect.y + rect.height / 2],
            [rect.right - 2, rect.bottom - 2],
          ]) {
            const link = document.elementFromPoint(x, y)?.closest("a");
            if (!link || link.getAttribute("href") !== expected)
              throw new Error(
                `${density}: cell content/padding must target its own row link`,
              );
            flushSync(() => link.click());
            const deadline = Date.now() + 2000;
            while (
              host.querySelector("output")?.textContent !== expected &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
            if (host.querySelector("output")?.textContent !== expected)
              throw new Error(
                "Row navigation must preserve filters and select the correct record",
              );
          }
        }
      }
      const sort = host.querySelector("th button")!;
      flushSync(() => (sort as HTMLButtonElement).click());
      if (!host.querySelector('th[aria-sort="ascending"]'))
        throw new Error("Row links must not intercept table sorting");
      flushSync(() => (sort as HTMLButtonElement).click());
      flushSync(() => (sort as HTMLButtonElement).click());
    }
    return "PASS: every cell and padding area targets its own native link in both densities; filters and sorting preserved";
  } finally {
    root.unmount();
    host.remove();
    if (previousDensity)
      document.documentElement.dataset.density = previousDensity;
    else delete document.documentElement.dataset.density;
  }
}
