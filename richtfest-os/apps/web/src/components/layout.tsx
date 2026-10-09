import type { ReactNode } from "react";
export function Page({ children }: { children: ReactNode }) {
  return <div className="page p-page">{children}</div>;
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
