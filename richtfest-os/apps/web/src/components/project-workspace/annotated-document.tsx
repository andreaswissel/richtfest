import { useEffect, useRef } from "react";
import type { RecordData } from "../../api";
import { ArtifactContent } from "./artifact-export";

export type DocumentSelection = {
  quote: string;
  selection: { start: number; end: number };
};

/** Offsets refer to the rendered text of this immutable revision, not a later draft. */
export function AnnotatedDocument({
  projectId,
  revision,
  notes,
  activeNote,
  onSelect,
}: {
  projectId: string;
  revision: RecordData;
  notes: RecordData[];
  activeNote?: { id: string };
  onSelect: (selection: DocumentSelection) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const highlights: Range[] = [];
      for (const note of notes) {
        if (!note.selection || !note.quote) continue;
        const { start, end } = note.selection;
        // Never guess an anchor when rendering or content no longer matches.
        if (element.textContent?.slice(start, end) !== note.quote) continue;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let offset = 0,
          started = false,
          node;
        while ((node = walker.nextNode())) {
          const length = node.textContent?.length ?? 0;
          if (!started && start < offset + length) {
            range.setStart(node, start - offset);
            started = true;
          }
          if (started && end <= offset + length) {
            range.setEnd(node, end - offset);
            highlights.push(range);
            if (note.id === activeNote?.id)
              node.parentElement?.scrollIntoView({ block: "center" });
            break;
          }
          offset += length;
        }
      }
      if (globalThis.CSS?.highlights && typeof Highlight !== "undefined")
        CSS.highlights.set("artifact-comments", new Highlight(...highlights));
    };
    update();
    // Markdown is loaded lazily. Re-anchor after its real text replaces the fallback.
    const observer = new MutationObserver(update);
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      globalThis.CSS?.highlights?.delete("artifact-comments");
    };
  }, [revision.id, notes, activeNote]);
  const capture = () => {
    const selected = window.getSelection();
    const element = root.current;
    if (!element || !selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    if (
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    )
      return;
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const quote = range.toString();
    if (quote.trim())
      onSelect({ quote, selection: { start, end: start + quote.length } });
  };
  return (
    <div
      ref={root}
      className="artifact-content"
      onMouseUp={capture}
      onKeyUp={capture}
      tabIndex={0}
    >
      <ArtifactContent projectId={projectId} revision={revision} />
    </div>
  );
}
