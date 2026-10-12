import { Component, type ReactNode } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { useT } from "../i18n";
import { Page, PageHeader } from "./layout";
import { Button } from "./ui/button";
import { Callout } from "./ui/primitives";

function isModuleLoadError(error: unknown) {
  return (
    error instanceof Error &&
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
      error.message,
    )
  );
}

function ReloadNotice({ moduleFailure = true }: { moduleFailure?: boolean }) {
  const t = useT();
  return (
    <Callout tone="error">
      <div className="grid gap-stack text-ui-sm">
        <p>{t(moduleFailure ? "moduleLoadFailed" : "pageRenderFailed")}</p>
        <p className="text-muted-foreground">{t("reloadCopyDraft")}</p>
        <div>
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(t("reloadConfirm"))) window.location.reload();
            }}
          >
            {t("reloadApp")}
          </Button>
        </div>
      </div>
    </Callout>
  );
}

/** Catch only asset-load failures, around the deferred content, not its composer. */
export class ModuleLoadBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) {
      // A rendering bug is not evidence of an outdated deployment.
      if (!isModuleLoadError(this.state.error)) throw this.state.error;
      return (
        <>
          {this.props.fallback}
          <ReloadNotice />
        </>
      );
    }
    return this.props.children;
  }
}

export function RouteLoading() {
  const t = useT();
  return (
    <Page>
      <div role="status">{t("loading")}</div>
    </Page>
  );
}

export function RouteError() {
  const error = useRouteError();
  const t = useT();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Page>
      <PageHeader title={t(notFound ? "pageNotFound" : "pageUnavailable")} />
      {notFound ? (
        <Callout>{t("pageNotFoundHint")}</Callout>
      ) : (
        <ReloadNotice moduleFailure={isModuleLoadError(error)} />
      )}
    </Page>
  );
}
