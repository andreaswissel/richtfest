import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { AGENT_MAX_OUTPUT_TOKENS } from "@richtfest/shared";
import { api, list, type RecordData } from "../api";
import { queryClient, useApi } from "../query";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Badge, Callout, Field, Segmented } from "./ui/primitives";

const efforts = ["low", "medium", "high", "ultra"];
const reasoningEfforts = ["low", "medium", "high", "xhigh"];
const roleLabels: Record<string, string> = {
  source_reviewer: "supervisorSourceReviewer",
  requirements_reviewer: "supervisorRequirementsReviewer",
  independent_reviewer: "supervisorIndependentReviewer",
  synthesizer: "supervisorSynthesizer",
};

type ProviderModel = { id: string; name: string };

function isRecommendedModel(provider: string, modelId: string) {
  if (provider === "openai") return /^gpt-6(?:[.-]|$)/i.test(modelId);
  if (provider === "anthropic")
    return /^claude-(?:opus|sonnet)-5-5(?:-|$)/i.test(modelId);
  return false;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function SupervisorPresets({
  provider = "openai",
}: {
  provider?: string;
}) {
  const t = useT();
  const [effort, setEffort] = useState("medium");
  const query = useApi(`/agent/presets?provider=${provider}`);
  const modelsQuery = useApi(`/agent/models?provider=${provider}`);
  const data = query.data as RecordData | undefined;
  const presets = list(data?.presets);
  const selected = useMemo(
    () => presets.find((preset) => preset.effort === effort) || presets[0],
    [presets, effort],
  );
  const [draft, setDraft] = useState<RecordData>();
  const activeDraft = draft || selected;
  useEffect(() => {
    if (selected) {
      setEffort(selected.effort || effort);
      setDraft(JSON.parse(JSON.stringify(selected)) as RecordData);
    }
  }, [selected?.effort, selected?.version, provider]);
  const save = useMutation({
    mutationFn: () => {
      if (!activeDraft) throw new Error(t("supervisorPresetUnavailable"));
      const {
        effort: presetEffort,
        provider: _provider,
        source,
        version,
        configured,
        ...body
      } = activeDraft;
      if (provider === "anthropic") {
        if (body.supervisor) delete body.supervisor.reasoningEffort;
        Object.values(body.specialists || {}).forEach((config: any) => {
          delete config.reasoningEffort;
        });
      }
      return api(`/agent/presets/${provider}/${presetEffort}`, body, "PUT");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/agent/presets?provider=${provider}`],
      });
    },
  });
  const reset = useMutation({
    mutationFn: () => api(`/agent/presets/${provider}/${effort}`, {}, "DELETE"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/agent/presets?provider=${provider}`],
      });
    },
  });
  const updateConfig = (path: string[], value: unknown) => {
    setDraft((current) => {
      const base = current || selected;
      if (!base) return current;
      const next = JSON.parse(JSON.stringify(base)) as RecordData;
      let target = next;
      path.slice(0, -1).forEach((key) => {
        target[key] = target[key] || {};
        target = target[key];
      });
      target[path.at(-1)!] = value;
      return next;
    });
  };
  if (query.isLoading) return null;
  if (query.error)
    return (
      <SectionShell title={t("supervisorPresets")}>
        <Callout>{query.error.message}</Callout>
      </SectionShell>
    );
  if (!data || !activeDraft)
    return (
      <SectionShell title={t("supervisorPresets")}>
        <Callout>{t("supervisorPresetUnavailable")}</Callout>
      </SectionShell>
    );
  const supervisor = activeDraft.supervisor || {};
  const specialists = activeDraft.specialists || {};
  const modelCatalog = modelsQuery.data as
    { models?: ProviderModel[] } | undefined;
  return (
    <SectionShell title={t("supervisorPresets")}>
      <p className="muted">{t("supervisorPresetsDescription")}</p>
      {data.enabled !== true && (
        <Callout>{t("supervisorPresetsDisabled")}</Callout>
      )}
      <div className="supervisor-preset-controls">
        <Field label={t("supervisorEffort")}>
          <Segmented
            value={activeDraft.effort || effort}
            onChange={(value) => {
              setEffort(value);
              const next = presets.find((preset) => preset.effort === value);
              setDraft(
                next
                  ? (JSON.parse(JSON.stringify(next)) as RecordData)
                  : undefined,
              );
            }}
            items={efforts.map((value) => ({
              value,
              label: t(`effort_${value}` as never),
            }))}
          />
        </Field>
        <Field
          label={t("supervisorIndependentReview")}
          hint={t("supervisorIndependentReviewDescription")}
        >
          <Segmented
            value={
              activeDraft.independentReviewEnabled === true
                ? "enabled"
                : "disabled"
            }
            onChange={(value) =>
              updateConfig(["independentReviewEnabled"], value === "enabled")
            }
            items={[
              { value: "disabled", label: t("disabled") },
              { value: "enabled", label: t("enabled") },
            ]}
          />
        </Field>
      </div>
      <div className="supervisor-preset-meta">
        <Badge>
          {activeDraft.source === "workspace"
            ? t("workspaceScope")
            : t("vendorDefault")}
        </Badge>
        <Badge tone={activeDraft.configured ? "success" : "neutral"}>
          {activeDraft.configured ? t("configured") : t("unconfigured")}
        </Badge>
        {activeDraft.version && (
          <span className="muted">
            {t("presetVersion")} {activeDraft.version}
          </span>
        )}
      </div>
      {provider !== "vercel" && modelsQuery.error && (
        <Callout>{modelsQuery.error.message}</Callout>
      )}
      <div className="supervisor-preset-grid">
        <PresetConfig
          title={t("supervisorRole")}
          config={supervisor}
          provider={provider}
          models={modelCatalog?.models || []}
          modelsLoading={modelsQuery.isLoading}
          onChange={(key, value) => updateConfig(["supervisor", key], value)}
          t={t}
        />
        {Object.entries(specialists).map(([role, config]) => (
          <PresetConfig
            key={role}
            title={
              t((roleLabels[role] || "supervisorSpecialist") as never) || role
            }
            config={config as RecordData}
            provider={provider}
            models={modelCatalog?.models || []}
            modelsLoading={modelsQuery.isLoading}
            onChange={(key, value) =>
              updateConfig(["specialists", role, key], value)
            }
            t={t}
          />
        ))}
      </div>
      <div className="supervisor-preset-limits">
        <Field label={t("supervisorMaxParallel")}>
          <Input
            type="number"
            min="1"
            max="3"
            value={activeDraft.maxParallel ?? 2}
            onChange={(event) =>
              updateConfig(["maxParallel"], numberValue(event.target.value, 2))
            }
          />
        </Field>
        <Field label={t("supervisorMaxTasks")}>
          <Input
            type="number"
            min="1"
            max="4"
            value={activeDraft.maxTasks ?? 4}
            onChange={(event) =>
              updateConfig(["maxTasks"], numberValue(event.target.value, 4))
            }
          />
        </Field>
        <Field label={t("supervisorMaxRevisions")}>
          <Input
            type="number"
            min="0"
            max="2"
            value={activeDraft.maxRevisions ?? 2}
            onChange={(event) =>
              updateConfig(["maxRevisions"], numberValue(event.target.value, 2))
            }
          />
        </Field>
      </div>
      {(save.error || reset.error) && (
        <Callout tone="error">{(save.error || reset.error)?.message}</Callout>
      )}
      {data.canManage !== true && <Callout>{t("supervisorAdminOnly")}</Callout>}
      <div className="inline-actions">
        <Button
          disabled={data.canManage !== true || save.isPending}
          onClick={() => save.mutate()}
        >
          {t("saveSupervisorPreset")}
        </Button>
        <Button
          variant="outline"
          disabled={
            data.canManage !== true ||
            reset.isPending ||
            activeDraft.source === "vendor"
          }
          onClick={() => reset.mutate()}
        >
          {t("resetSupervisorPreset")}
        </Button>
        {save.isSuccess && (
          <Badge tone="success" role="status">
            {t("supervisorPresetSaved")}
          </Badge>
        )}
      </div>
    </SectionShell>
  );
}

function PresetConfig({
  title,
  config,
  provider,
  models,
  modelsLoading,
  onChange,
  t,
}: {
  title: string;
  config: RecordData;
  provider: string;
  models: ProviderModel[];
  modelsLoading: boolean;
  onChange: (key: string, value: unknown) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div className="supervisor-preset-config">
      <h3>{title}</h3>
      <Field label={t("supervisorModel")}>
        {provider === "vercel" ? (
          <Input
            value={config.modelId || ""}
            onChange={(event) => onChange("modelId", event.target.value)}
          />
        ) : (
          <NativeSelect
            value={config.modelId || ""}
            disabled={modelsLoading}
            onChange={(event) => onChange("modelId", event.target.value)}
          >
            {config.modelId &&
              !models.some((model) => model.id === config.modelId) && (
                <option value={config.modelId}>
                  {config.modelId} ({t("modelNotInCatalog")})
                </option>
              )}
            <option value="" disabled>
              {modelsLoading ? t("loadingModels") : t("selectModel")}
            </option>
            {models.filter((model) => isRecommendedModel(provider, model.id))
              .length > 0 && (
              <optgroup label={t("recommendedModels")}>
                {models
                  .filter((model) => isRecommendedModel(provider, model.id))
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
              </optgroup>
            )}
            <optgroup label={t("availableModels")}>
              {models
                .filter((model) => !isRecommendedModel(provider, model.id))
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
            </optgroup>
          </NativeSelect>
        )}
      </Field>
      {provider !== "anthropic" && (
        <Field label={t("supervisorReasoningEffort")}>
          <NativeSelect
            value={config.reasoningEffort || ""}
            onChange={(event) =>
              onChange("reasoningEffort", event.target.value || undefined)
            }
          >
            <option value="">{t("supervisorReasoningDefault")}</option>
            {reasoningEfforts.map((value) => (
              <option key={value} value={value}>
                {t(`effort_${value}` as never)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <div className="supervisor-preset-numbers">
        <Field label={t("supervisorMaxOutputTokens")}>
          <Input
            type="number"
            min="256"
            max={AGENT_MAX_OUTPUT_TOKENS}
            value={config.maxOutputTokens ?? 4096}
            onChange={(event) =>
              onChange("maxOutputTokens", numberValue(event.target.value, 4096))
            }
          />
        </Field>
        <Field label={t("supervisorMaxSteps")}>
          <Input
            type="number"
            min="1"
            value={config.maxSteps ?? 8}
            onChange={(event) =>
              onChange("maxSteps", numberValue(event.target.value, 8))
            }
          />
        </Field>
      </div>
    </div>
  );
}

function SectionShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <div className="supervisor-preset-content">{children}</div>
    </section>
  );
}
