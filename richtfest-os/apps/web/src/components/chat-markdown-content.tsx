import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./chat-markdown.css";

const plugins = [remarkGfm];

export default function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
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
