import { lazy, memo, Suspense } from "react";
import { ModuleLoadBoundary } from "./module-recovery";

const MarkdownContent = lazy(() => import("./chat-markdown-content"));

/** Keep the Markdown parser off the application boot path. */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
}: {
  children: string;
}) {
  const plainText = <div className="preserve-lines">{children}</div>;
  return (
    <ModuleLoadBoundary fallback={plainText}>
      <Suspense fallback={plainText}>
        <MarkdownContent>{children}</MarkdownContent>
      </Suspense>
    </ModuleLoadBoundary>
  );
});
