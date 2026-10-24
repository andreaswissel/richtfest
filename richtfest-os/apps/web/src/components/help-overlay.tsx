import { useEffect, useRef } from "react";
import { ClipboardList, MessageCircle } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Help } from "../screens/help";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import "./help-overlay.css";

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const project = /^\/projects\/[^/]+$/.test(pathname);
  const projectParams = new URLSearchParams(params);
  projectParams.delete("guide");
  if (params.get("view") !== "workspace") projectParams.set("assistant", "1");
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={t("help")}
      id="help-overlay"
      className="help-overlay"
    >
      <header className="flex items-center justify-between gap-stack border-b p-page">
        <strong className="min-w-0 text-ui-sm">{t("help")}</strong>
        <div className="flex shrink-0 items-center gap-stack">
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              to="/help?tab=reports"
              aria-label={t("helpReports")}
              title={t("helpReports")}
            >
              <ClipboardList aria-hidden="true" />
            </Link>
          </Button>
          {project && (
            <Button asChild variant="ghost" size="icon-sm">
              <Link
                to={`${pathname}?${projectParams}`}
                aria-label={t("workspaceConversation")}
                title={t("workspaceConversation")}
              >
                <MessageCircle aria-hidden="true" />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("close")}
            onClick={onClose}
          >
            ×
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-page">
        <Help embedded />
      </div>
    </aside>
  );
}
