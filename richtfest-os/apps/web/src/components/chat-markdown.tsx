import { lazy, memo, Suspense } from "react";

const MarkdownContent = lazy(() => import("./chat-markdown-content"));

/** Keep the Markdown parser off the application boot path. */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
}: {
  children: string;
}) {
  return (
    <Suspense fallback={<div className="preserve-lines">{children}</div>}>
      <MarkdownContent>{children}</MarkdownContent>
    </Suspense>
  );
});
