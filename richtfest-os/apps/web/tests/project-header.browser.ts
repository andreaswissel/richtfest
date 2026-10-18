/** Run on a project view in Vite at desktop and narrow widths:
 * import('/tests/project-header.browser.ts').then(m => m.testProjectHeader())
 */
export function testProjectHeader() {
  const header = document.querySelector<HTMLElement>(".project-bar")!;
  const title = header.querySelector<HTMLElement>(".project-bar-title")!;
  const nav = header.querySelector<HTMLElement>("nav")!;
  const actions = header.querySelector<HTMLElement>(".project-bar-actions")!;
  if (!header.getBoundingClientRect().height)
    throw new Error(
      "Open a non-conversation project view to test the visible header",
    );
  const original = [...title.childNodes];
  const originalBadge = title.querySelector<HTMLElement>(
    '[data-slot="badge"]',
  )!;
  const edit = document.createElement("button");
  edit.textContent = "Projektdetails bearbeiten";
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
      for (const withAction of [false, true]) {
        if (withAction) actions.append(edit);
        const actual = positions();
        maxShift = Math.max(
          maxShift,
          ...actual.flatMap((point, i) => [
            Math.abs(point.x - expected[i].x),
            Math.abs(point.y - expected[i].y),
          ]),
        );
        if (maxShift > 0.5)
          throw new Error(
            `Project links shifted for ${name}, action=${withAction}`,
          );
        if (header.getBoundingClientRect().height !== height)
          throw new Error("Project metadata changed the header height");
        edit.remove();
      }
    }
    if (document.documentElement.scrollWidth > innerWidth)
      throw new Error("Project header overflows the viewport");
    return { width: innerWidth, cases: 6, maxShift };
  } finally {
    title.replaceChildren(...original);
    edit.remove();
  }
}
