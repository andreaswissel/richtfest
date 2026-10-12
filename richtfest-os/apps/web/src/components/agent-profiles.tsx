import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { queryClient, useApi } from "../query";
import { useT } from "../i18n";
import { Section } from "./layout";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge, Callout, Field } from "./ui/primitives";

const roleLabels: Record<string, Parameters<ReturnType<typeof useT>>[0]> = {
  supervisor: "supervisorRole",
  source_reviewer: "supervisorSourceReviewer",
  requirements_reviewer: "supervisorRequirementsReviewer",
  independent_reviewer: "supervisorIndependentReviewer",
  sound_insulation: "supervisorSoundInsulation",
  construction_law: "supervisorConstructionLaw",
  cost_optimizer: "supervisorCostOptimizer",
};
type Profile = {
  key: string;
  label: string;
  instructions: string;
  triggerPhrases: string[];
  knowledgeIds: string[];
  version: number;
};
type Knowledge = { id: string; title: string; body: string };
type ProfilesResponse = {
  enabled: boolean;
  profiles: Profile[];
  knowledge: Knowledge[];
  canManage: boolean;
};
const endpoint = "/knowledge/agent-profiles";

export function AgentProfiles() {
  const t = useT();
  const query = useApi(endpoint);
  const data = query.data as ProfilesResponse | undefined;
  const [selected, setSelected] = useState("supervisor");
  const profiles =
    data?.profiles.filter((profile) => roleLabels[profile.key]) || [];
  const active = profiles.some((profile) => profile.key === selected)
    ? selected
    : profiles[0]?.key;
  return (
    <Section title={t("agentProfilesTitle")}>
      <div className="grid gap-stack">
        <p className="muted">{t("agentProfilesDescription")}</p>
        {query.isLoading && <p role="status">{t("loading")}</p>}
        {query.error && <Callout tone="error">{query.error.message}</Callout>}
        {data && (
          <div className="grid gap-stack">
            {data.enabled === false && (
              <Callout>{t("agentProfilesDisabled")}</Callout>
            )}
            {!data.canManage && <Callout>{t("agentProfileAdminOnly")}</Callout>}
            <Field label={t("agentProfileRole")}>
              <div className="flex min-w-0 flex-wrap gap-2" role="group">
                {profiles.map((profile) => (
                  <Button
                    key={profile.key}
                    type="button"
                    variant="outline"
                    aria-pressed={active === profile.key}
                    className="h-auto max-w-full whitespace-normal py-cell aria-pressed:bg-muted aria-pressed:border-foreground"
                    onClick={() => setSelected(profile.key)}
                  >
                    {t(roleLabels[profile.key])}
                  </Button>
                ))}
              </div>
            </Field>
            {profiles.map((profile) => (
              <div key={profile.key} hidden={active !== profile.key}>
                <ProfileEditor
                  profile={profile}
                  knowledge={data.knowledge}
                  canManage={data.canManage === true}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

function ProfileEditor({
  profile,
  knowledge,
  canManage,
}: {
  profile: Profile;
  knowledge: Knowledge[];
  canManage: boolean;
}) {
  const t = useT();
  const [instructions, setInstructions] = useState(profile.instructions);
  const [phrases, setPhrases] = useState(profile.triggerPhrases.join("\n"));
  const [knowledgeIds, setKnowledgeIds] = useState(profile.knowledgeIds);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setInstructions(profile.instructions);
    setPhrases(profile.triggerPhrases.join("\n"));
    setKnowledgeIds(profile.knowledgeIds);
  }, [profile, dirty]);
  const save = useMutation({
    mutationFn: () =>
      api(
        `${endpoint}/${profile.key}`,
        {
          instructions,
          triggerPhrases: phrases
            .split("\n")
            .map((phrase) => phrase.trim())
            .filter(Boolean),
          knowledgeIds,
        },
        "PUT",
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [endpoint] });
      setDirty(false);
    },
  });
  const changed = () => {
    setDirty(true);
    save.reset();
  };
  const disabled = !canManage || save.isPending;
  return (
    <form
      className="grid gap-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && dirty) save.mutate();
      }}
    >
      <Field
        label={t("agentProfileInstructions")}
        hint={t("agentProfileInstructionsHint")}
      >
        <Textarea
          className="text-ui md:text-ui"
          rows={4}
          value={instructions}
          disabled={disabled}
          onChange={(event) => {
            setInstructions(event.target.value);
            changed();
          }}
        />
      </Field>
      <Field
        label={t("agentProfileRoutingHints")}
        hint={t("agentProfileRoutingHintDescription")}
      >
        <Textarea
          className="text-ui md:text-ui"
          rows={2}
          value={phrases}
          disabled={disabled}
          onChange={(event) => {
            setPhrases(event.target.value);
            changed();
          }}
        />
      </Field>
      <fieldset className="grid min-w-0 gap-stack" disabled={disabled}>
        <legend className="mb-2 text-ui font-medium">
          {t("agentProfileKnowledge")}
        </legend>
        {knowledge.length === 0 && (
          <p className="muted">{t("agentProfileNoKnowledge")}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {knowledge.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant="outline"
              aria-pressed={knowledgeIds.includes(entry.id)}
              className="h-auto whitespace-normal text-left aria-pressed:bg-muted aria-pressed:border-foreground"
              onClick={() => {
                setKnowledgeIds((ids) =>
                  ids.includes(entry.id)
                    ? ids.filter((id) => id !== entry.id)
                    : [...ids, entry.id],
                );
                changed();
              }}
            >
              {entry.title}
            </Button>
          ))}
        </div>
      </fieldset>
      {save.error && <Callout tone="error">{save.error.message}</Callout>}
      <div className="inline-actions">
        {canManage && (
          <Button type="submit" disabled={disabled || !dirty}>
            {save.isPending ? t("saving") : t("agentProfileSave")}
          </Button>
        )}
        {save.isSuccess && !dirty && (
          <Badge tone="success" role="status">
            {t("agentProfileSaved")}
          </Badge>
        )}
      </div>
    </form>
  );
}
