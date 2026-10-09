import { useState } from "react";
import { useApi } from "../query";
import { list } from "../api";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { Badge, Callout, Empty } from "./ui/primitives";

/** Entity-scoped, opt-in history. Raw audit metadata is never rendered. */
export function Activity({
  entityType,
  entityId,
}: {
  entityType: "project" | "customer" | "draft";
  entityId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useApi(
    `/activity?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    open,
  );
  return (
    <div className="entity-activity">
      <Button variant="link" onClick={() => setOpen((v) => !v)}>
        {open ? t("hideActivity") : t("showActivity")}
      </Button>
      {open && (
        <div className="activity-list">
          {query.isPending && <p className="muted">{t("loading")}</p>}
          {query.error && <Callout tone="error">{query.error.message}</Callout>}
          {list(query.data, "items").map((event) => (
            <article className="activity-item" key={event.id}>
              <div>
                <strong>{event.actorName || t("systemActor")}</strong>
                <span className="muted">{validTime(event.createdAt)}</span>
                {event.status && <Badge>{event.status}</Badge>}
              </div>
              <p>{event.summary || event.action}</p>
              {event.rationale && <p className="muted">{event.rationale}</p>}
            </article>
          ))}
          {query.data && !list(query.data, "items").length && (
            <Empty>{t("noActivity")}</Empty>
          )}
          <div className="inline-actions">
            {cursor && (
              <Button onClick={() => setCursor(null)}>
                {t("latestActivity")}
              </Button>
            )}
            {query.data?.nextCursor && (
              <Button onClick={() => setCursor(query.data!.nextCursor)}>
                {t("olderActivity")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function validTime(value: unknown) {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
