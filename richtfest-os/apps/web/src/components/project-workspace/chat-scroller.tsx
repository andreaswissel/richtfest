import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import {
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "../ui/message-scroller";

const FollowingContext = createContext<{
  autoScroll: boolean;
  setAutoScroll: (value: boolean) => void;
} | null>(null);

/** Reader policy only; the shadcn primitive owns scroll geometry and resizing. */
export function ChatScrollerProvider({ children }: { children: ReactNode }) {
  const [autoScroll, setAutoScroll] = useState(true);
  return (
    <FollowingContext.Provider value={{ autoScroll, setAutoScroll }}>
      <MessageScrollerProvider
        autoScroll={autoScroll}
        scrollPreviousItemPeek={0}
      >
        {children}
      </MessageScrollerProvider>
    </FollowingContext.Provider>
  );
}

export function useChatScroller() {
  const context = useContext(FollowingContext)!;
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable();
  const { autoScroll, setAutoScroll } = context;
  const pauseFollowing = useCallback(
    () => setAutoScroll(false),
    [setAutoScroll],
  );
  const resumeFollowing = useCallback(() => {
    // scrollToEnd must see the enabled prop, not the previous render's value.
    flushSync(() => setAutoScroll(true));
    scrollToEnd({ behavior: "instant" });
  }, [setAutoScroll, scrollToEnd]);
  return {
    following: autoScroll && !end,
    showLatest: !autoScroll || end,
    pauseFollowing,
    resumeFollowing,
  };
}

export function ChatScrollerViewport({
  onWheel,
  onKeyDown,
  onTouchStart,
  onTouchMove,
  onClick,
  ...props
}: ComponentProps<typeof MessageScrollerViewport>) {
  const viewport = useRef<HTMLDivElement>(null);
  const touchY = useRef<number | undefined>(undefined);
  const { following, pauseFollowing } = useChatScroller();
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    const select = () => {
      const selection = window.getSelection();
      if (
        viewport.current &&
        selection?.toString() &&
        selection.rangeCount &&
        selection.getRangeAt(0).intersectsNode(viewport.current)
      )
        pauseFollowing();
    };
    document.addEventListener("selectionchange", select);
    return () => document.removeEventListener("selectionchange", select);
  }, [pauseFollowing]);
  return (
    <MessageScrollerViewport
      {...props}
      ref={viewport}
      // Native anchoring can follow a growing selected paragraph even when
      // autoScroll is disabled. The primitive already preserves reader position.
      style={{ ...props.style, overflowAnchor: "none" }}
      onWheel={(event) => {
        // The primitive releases following on wheel intent, even at the end
        // where a downward wheel cannot produce a scroll event to re-arm it.
        if (following && event.deltaY >= 0)
          scrollToEnd({ behavior: "instant" });
        onWheel?.(event);
      }}
      onKeyDown={(event) => {
        if (
          following &&
          !event.shiftKey &&
          ["ArrowDown", "PageDown", "End", " "].includes(event.key)
        )
          scrollToEnd({ behavior: "instant" });
        onKeyDown?.(event);
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY;
        onTouchStart?.(event);
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        if (
          following &&
          y !== undefined &&
          touchY.current !== undefined &&
          y < touchY.current
        )
          scrollToEnd({ behavior: "instant" });
        touchY.current = y;
        onTouchMove?.(event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) pauseFollowing();
        onClick?.(event);
      }}
    />
  );
}

export function ChatLatest({
  unread = 0,
  onLatest,
}: {
  unread?: number;
  onLatest?: () => void;
}) {
  const t = useT();
  const { showLatest, resumeFollowing } = useChatScroller();
  if (!showLatest) return null;
  return (
    <div className="workspace-jump">
      <Button
        variant="outline"
        onClick={() => {
          resumeFollowing();
          onLatest?.();
        }}
      >
        {t("workspaceLatest")} {unread > 0 && `· ${unread}`}
      </Button>
    </div>
  );
}
