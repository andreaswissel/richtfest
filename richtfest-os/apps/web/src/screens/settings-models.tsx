import { Page, PageHeader } from "../components/layout";
import { SettingsNavigation } from "../components/settings-navigation";
import { SupervisorPresets } from "../components/supervisor-presets";
import { Badge } from "../components/ui/primitives";
import {
  getSelectedProvider,
  providerLabel,
  type ConnectionsState,
} from "../connection-policy";
import { useT } from "../i18n";
import { useApi } from "../query";
import { LoadState } from "./foundation";

export function SettingsModels() {
  const t = useT();
  const query = useApi("/settings/ai-connections");
  const data = query.data as ConnectionsState | undefined;
  const provider = data ? getSelectedProvider(data) : undefined;
  return (
    <Page>
      <PageHeader
        eyebrow={t("settings")}
        title={t("supervisorPresets")}
        titleAside={provider && <Badge>{providerLabel(provider)}</Badge>}
      />
      <SettingsNavigation />
      <LoadState query={query} />
      {provider && <SupervisorPresets provider={provider} />}
    </Page>
  );
}
