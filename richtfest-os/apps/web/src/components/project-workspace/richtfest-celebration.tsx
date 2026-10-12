import { useEffect, useRef, useState, type MouseEvent } from "react";
import { X } from "lucide-react";
import type { RecordData } from "../../api";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import type { WorkspaceMessage } from "./types";
import "./richtfest-celebration.css";

// Deliberately ephemeral: leaving this conversation resets the easter egg.
export function useRichtfestCelebration(
  conversationId: string,
  runs: RecordData[],
  messages: WorkspaceMessage[],
) {
  const [enabled, setEnabled] = useState(false);
  const [celebrating, setCelebrating] = useState<{
    id: string;
    preview: boolean;
  }>();
  const taps = useRef({ count: 0, startedAt: 0 });
  const pending = useRef(new Set<string>());
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      pending.current.clear();
      setCelebrating(undefined);
      return;
    }
    for (const run of runs) {
      if (run.parentRunId || run.conversationId !== conversationId) continue;
      if (["queued", "running"].includes(run.status)) {
        if (!seen.current.has(run.id)) pending.current.add(run.id);
        continue;
      }
      if (!pending.current.has(run.id)) continue;
      if (!["needs_review", "approved"].includes(run.status)) {
        pending.current.delete(run.id);
        continue;
      }
      // Status and message caches may arrive in either order. Wait for the
      // persisted final answer, not a streaming placeholder or specialist result.
      if (
        !run.outputSummary?.trim() ||
        !messages.some(
          (message) =>
            message.runId === run.id &&
            message.actorKind === "agent" &&
            message.body === run.outputSummary,
        )
      )
        continue;
      pending.current.delete(run.id);
      seen.current.add(run.id);
      setCelebrating({ id: run.id, preview: false });
    }
  }, [enabled, conversationId, runs, messages]);

  useEffect(() => {
    if (!celebrating) return;
    const timeout = window.setTimeout(() => setCelebrating(undefined), 5000);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCelebrating(undefined);
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", dismiss);
    };
  }, [celebrating]);

  function onChatClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    // Count only bare scroller surfaces, never messages, selections or controls.
    if (
      !target.matches(
        '[data-slot="message-scroller-viewport"], [data-slot="message-scroller-content"]',
      ) ||
      window.getSelection()?.toString() ||
      event.button !== 0
    )
      return;
    const now = Date.now();
    if (now - taps.current.startedAt > 5000)
      taps.current = { count: 0, startedAt: now };
    if (++taps.current.count === 10) {
      taps.current = { count: 0, startedAt: 0 };
      setEnabled(true);
      setCelebrating({ id: crypto.randomUUID(), preview: true });
    }
  }

  return {
    enabled,
    disable: () => setEnabled(false),
    onChatClick,
    celebration: celebrating ? (
      <RichtfestCelebration
        key={celebrating.id}
        preview={celebrating.preview}
        onDismiss={() => setCelebrating(undefined)}
      />
    ) : null,
  };
}

function RichtfestCelebration({
  onDismiss,
  preview,
}: {
  onDismiss: () => void;
  preview: boolean;
}) {
  const t = useT();
  return (
    <div className="richtfest-celebration">
      <svg
        className="richtfest-celebration__art"
        viewBox="0 0 160 130"
        aria-hidden="true"
        focusable="false"
      >
        <g className="richtfest-celebration__scaffold">
          <path d="M12 119V82m8 37V88M8 94h17M8 108h17M140 119V82m8 37V88M135 94h17M135 108h17M7 122h146" />
        </g>
        <g className="richtfest-celebration__roof">
          <path d="M28 117V94h5v23zm99 0V94h5v23zM77 119V60h6v59z" />
          <path d="m15 110 65-55 65 55-4 5-61-51-61 51z" />
          <path d="M36 99h88v5H36z" />
          <path d="m47 102 30-31m6 0 30 31" fill="none" />
        </g>
        <g className="richtfest-celebration__wreath">
          <path
            className="richtfest-celebration__rope"
            d="M80-36v49m-3 0a3 3 0 1 0 6 0M80 19 65 32m15-13 15 13"
          />
          <circle
            className="richtfest-celebration__green"
            cx="80"
            cy="41"
            r="17"
          />
          <circle
            className="richtfest-celebration__leaves"
            cx="80"
            cy="41"
            r="17"
          />
          <g className="richtfest-celebration__ribbons">
            <path d="M65 45q-8 11-4 23" stroke="#c77960" />
            <path d="M70 54q3 10-1 18" stroke="#d7b565" />
            <path d="M94 45q8 11 4 22" stroke="#8297b1" />
            <path d="M89 54q-3 10 1 18" stroke="#c77960" />
          </g>
        </g>
        <g className="richtfest-celebration__sparks">
          <path d="m46 36-5-3m10-7-2-5m65 15 5-3m-10-7 2-5" />
        </g>
      </svg>
      <div role="status" className="min-w-0">
        <p className="text-ui-lg font-semibold">
          {t("workspaceRichtfestTitle")}
        </p>
        <p className="text-ui-sm text-muted-foreground">
          {t(preview ? "workspaceRichtfestPreview" : "workspaceRichtfestResult")}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="richtfest-celebration__close"
        aria-label={t("workspaceRichtfestDismiss")}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
