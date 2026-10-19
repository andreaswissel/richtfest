import type { ReactNode } from "react";
export function Page({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`page p-page ${className}`}>{children}</div>;
}
export function PageHeader({
  eyebrow,
  title,
  titleAside,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  titleAside?: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <div className="page-header-title">
          <h1>{title}</h1>
          {titleAside}
        </div>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
export function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{title}</h2>
        {meta}
      </div>
      {children}
    </section>
  );
}

/** A titled part of a Section: a sentence-case heading, a short status and its actions on one line. */
export function Subsection({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="subsection">
      <div className="subsection-heading">
        <h3>{title}</h3>
        {meta && <span className="subsection-meta">{meta}</span>}
        {actions && <div className="subsection-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** An inline form for adding a record below its table, set apart by a tinted panel and a small title. */
export function FormPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="form-panel" role="group" aria-label={title}>
      <div className="form-panel-title">{title}</div>
      {children}
    </div>
  );
}
