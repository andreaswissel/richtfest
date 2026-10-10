import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Input } from "../src/components/ui/input";
import { Textarea } from "../src/components/ui/textarea";
import { NativeSelect } from "../src/components/ui/native-select";

/** Run in Vite at phone and desktop widths, plus a wide touch viewport:
 * import('/tests/form-typography.browser.tsx').then(m => m.testFormTypography())
 * Checks the font-size prerequisite for iOS focus zoom, not the native keyboard.
 */
export function testFormTypography() {
  const host = document.createElement("div");
  const previousDensity = document.documentElement.dataset.density;
  host.style.cssText = "position:fixed;inset:0;z-index:9999;background:white";
  document.body.append(host);
  const root = createRoot(host);
  const mobile = innerWidth < 768 || matchMedia("(pointer: coarse)").matches;
  const results: { density: string; fonts: string[] }[] = [];
  try {
    flushSync(() =>
      root.render(
        <>
          <Input aria-label="Email" type="email" />
          <Input aria-label="Password" type="password" />
          <Input aria-label="Amount" type="number" />
          <div className="workspace-search">
            <Input aria-label="Search" type="search" />
          </div>
          <Textarea aria-label="Message" className="text-ui-sm" />
          <div className="workspace-composer-controls">
            <NativeSelect aria-label="Provider">
              <option>Provider</option>
            </NativeSelect>
          </div>
          <div
            contentEditable
            suppressContentEditableWarning
            className="text-ui-xs"
          >
            Note
          </div>
        </>,
      ),
    );
    for (const density of ["dense", "normal"]) {
      document.documentElement.dataset.density = density;
      const controls = [
        ...host.querySelectorAll<HTMLElement>(
          "input, textarea, select, [contenteditable]",
        ),
      ];
      for (const control of controls) {
        for (const focused of [false, true]) {
          if (focused) control.focus();
          const size = parseFloat(getComputedStyle(control).fontSize);
          if (mobile && size < 16) {
            throw new Error(
              `${density} ${control.getAttribute("aria-label") || "Note"} ${focused ? "focused" : "unfocused"}: ${size}px is below the iOS focus-zoom threshold`,
            );
          }
          control.blur();
        }
      }
      const fonts = controls.map(
        (control) => getComputedStyle(control).fontSize,
      );
      if (!mobile && fonts[0] !== (density === "dense" ? "13px" : "15px")) {
        throw new Error(
          `Desktop ${density} input density changed: ${fonts[0]}`,
        );
      }
      results.push({ density, fonts });
    }
    return { mobile, results };
  } finally {
    root.unmount();
    host.remove();
    if (previousDensity === undefined)
      delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = previousDensity;
  }
}
