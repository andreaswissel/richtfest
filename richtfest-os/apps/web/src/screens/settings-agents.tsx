import { AgentProfiles } from "../components/agent-profiles";
import { Page, PageHeader } from "../components/layout";
import { SettingsNavigation } from "../components/settings-navigation";
import { useT } from "../i18n";

export function SettingsAgents() {
  const t = useT();
  return (
    <Page>
      <PageHeader eyebrow={t("settings")} title={t("agentProfilesTitle")} />
      <SettingsNavigation />
      <AgentProfiles />
    </Page>
  );
}
