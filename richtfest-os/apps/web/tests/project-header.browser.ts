/** Run on a project view in Vite at desktop and narrow widths:
 * import('/tests/project-header.browser.ts').then(m => m.testProjectHeader())
 */
export function testProjectHeader() {
  const header = document.querySelector<HTMLElement>(".project-bar")!;
  const title = header.querySelector<HTMLElement>(".project-bar-title")!;
  const nav = document.querySelector<HTMLElement>(".project-module-bar nav")!;
  if (!header.getBoundingClientRect().height)
    throw new Error("Open a project view to test the visible header");
  const original = [...title.childNodes];
  const originalBadge = title.querySelector<HTMLElement>(
    '[data-slot="badge"]',
  )!;
  const positions = () =>
    [...nav.querySelectorAll("a")].map((link) => {
      const { x, y } = link.getBoundingClientRect();
      return { x, y };
    });
  nav.scrollLeft = 0;
  const expected = positions();
  const height = header.getBoundingClientRect().height;
  let maxShift = 0;
  try {
    for (const [name, status, customer] of [
      ["Projekt", "", ""],
      ["Bendenweg 6, Alzey", "Planung", "ELAs 2 GmbH"],
      [
        "Ein sehr langer Projektname für ein umfangreiches Bauvorhaben",
        "Abgeschlossen",
        "Ein sehr langer Kundenname GmbH",
      ],
    ]) {
      const heading = document.createElement("h1");
      heading.textContent = name;
      const badge = originalBadge.cloneNode(true) as HTMLElement;
      badge.textContent = status;
      const company = document.createElement("span");
      company.className = "project-bar-customer";
      company.textContent = customer;
      title.replaceChildren(
        ...(customer ? [company] : []),
        heading,
        ...(status ? [badge] : []),
      );
      const actual = positions();
      maxShift = Math.max(
        maxShift,
        ...actual.flatMap((point, i) => [
          Math.abs(point.x - expected[i].x),
          Math.abs(point.y - expected[i].y),
        ]),
      );
      if (maxShift > 0.5) throw new Error(`Project links shifted for ${name}`);
      if (header.getBoundingClientRect().height !== height)
        throw new Error("Project metadata changed the header height");
    }
    if (document.documentElement.scrollWidth > innerWidth)
      throw new Error("Project header overflows the viewport");
    return { width: innerWidth, cases: 3, maxShift };
  } finally {
    title.replaceChildren(...original);
  }
}

/** Run on a loaded project, for each perspective and viewport width.
 * Exercises real tab transitions, including lazy editor CSS and content scrolling.
 */
export async function testProjectNavigation() {
  const nav = document.querySelector<HTMLElement>(".project-module-bar nav")!;
  const links = [
    ...nav.querySelectorAll<HTMLAnchorElement>("a:not(.project-all-modules)"),
  ];
  const original = links.find(
    (link) => link.getAttribute("aria-current") === "page",
  )!;
  const frame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const positions = () => {
    nav.scrollLeft = 0;
    return [
      ...document.querySelectorAll<HTMLElement>(
        ".project-bar, .project-module-bar, .project-module-bar a",
      ),
    ].flatMap((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return [x, y, width, height];
    });
  };
  const expected = positions();
  let maxShift = 0;
  let scrolledViews = 0;
  const views: string[] = [];
  const check = (view: string) => {
    const actual = positions();
    if (actual.length !== expected.length)
      throw new Error(`Navigation changed on ${view}`);
    maxShift = Math.max(
      maxShift,
      ...actual.map((value, i) => Math.abs(value - expected[i])),
    );
    if (maxShift > 0.5)
      throw new Error(`Navigation shifted ${maxShift}px on ${view}`);
    if (!nav.getBoundingClientRect().height)
      throw new Error(`Navigation hidden on ${view}`);
    if (
      document.documentElement.scrollWidth > innerWidth ||
      document.documentElement.scrollHeight > innerHeight
    )
      throw new Error(`Project escaped its viewport on ${view}`);
  };
  try {
    for (const link of links) {
      const view = new URL(link.href).searchParams.get("view")!;
      link.click();
      const deadline = performance.now() + 10_000;
      while (
        link.getAttribute("aria-current") !== "page" ||
        (view === "location" && !document.querySelector(".location-editor"))
      ) {
        if (performance.now() > deadline)
          throw new Error(`Tab did not load: ${view}`);
        await frame();
        check(view);
      }
      // Include post-navigation layout, lazy stylesheet application and query completion.
      const settleUntil = performance.now() + 750;
      while (performance.now() < settleUntil) {
        await frame();
        check(view);
      }
      const content = document.querySelector<HTMLElement>(
        ".project-module-content",
      )!;
      content.scrollTop = content.scrollHeight;
      await frame();
      if (content.scrollTop > 0) scrolledViews++;
      check(`${view} scrolled`);
      content.scrollTop = 0;
      views.push(view);
    }
    return {
      width: innerWidth,
      perspective: new URLSearchParams(location.search).get("perspective"),
      views,
      scrolledViews,
      maxShift,
    };
  } finally {
    original.click();
    await frame();
  }
}
