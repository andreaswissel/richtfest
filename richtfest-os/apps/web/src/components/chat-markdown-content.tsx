import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useLocation } from "react-router-dom";
import "./chat-markdown.css";

const plugins = [remarkGfm];

export default function MarkdownContent({ children }: { children: string }) {
  const location = useLocation();
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        components={{
          a: ({ href, children }) => {
            // Only app-owned project document links become in-app previews.
            // External URLs retain their usual new-tab behavior.
            if (href?.startsWith("/projects/")) {
              const url = new URL(href, "https://richtfest.invalid");
              if (
                url.searchParams.has("sourceVersion") ||
                url.searchParams.has("artifact")
              ) {
                const current = new URLSearchParams(location.search);
                if (
                  url.pathname === location.pathname &&
                  !url.searchParams.has("conversation") &&
                  current.has("conversation")
                )
                  url.searchParams.set(
                    "conversation",
                    current.get("conversation")!,
                  );
                return (
                  <Link to={`${url.pathname}${url.search}`}>{children}</Link>
                );
              }
            }
            return href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          // Model-authored images must not trigger external tracking requests.
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="chat-markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
