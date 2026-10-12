import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AGENT_MAX_OUTPUT_TOKENS,
  agentPresetSnapshotSchema,
} from "@richtfest/shared";
import { api, ApiError, type RecordData } from "../../api";
import { useT } from "../../i18n";
import { queryClient } from "../../query";
import { Button } from "../ui/button";
import { Callout } from "../ui/primitives";
import { providerActivityMetadata } from "./run-activity";

export function tokenLimitCandidate(run: RecordData) {
  if (run.status !== "failed" || !run.failureEvent) return;
  if (
    /(?:^|;)\s*category=timeout(?:;|$)/.test(
      String(run.error || run.failureReason || ""),
    )
  )
    return;
  const diagnostics = providerActivityMetadata(run.failureEvent).diagnostics;
  if (diagnostics?.finishReason !== "length") return;
  const role: unknown = run.failureRole;
  if (
    role !== "supervisor" &&
    role !== "source_reviewer" &&
    role !== "requirements_reviewer" &&
    role !== "sound_insulation" &&
    role !== "construction_law" &&
    role !== "cost_optimizer"
  )
    return;
  const parsed = agentPresetSnapshotSchema.safeParse(run.modelPolicy);
  if (!parsed.success) return;
  const policy = parsed.data;
  const model =
    role === "supervisor" ? policy.supervisor : policy.specialists[role];
  if (!model) return;
  return { role, policy, model };
}

export function TokenLimitAction({
  run,
  onDescribe,
}: {
  run: RecordData;
  onDescribe?: () => void;
}) {
  const candidate = tokenLimitCandidate(run);
  return candidate ? (
    <TokenLimitDecision candidate={candidate} onDescribe={onDescribe} />
  ) : null;
}

function TokenLimitDecision({
  candidate,
  onDescribe,
}: {
  candidate: NonNullable<ReturnType<typeof tokenLimitCandidate>>;
  onDescribe?: () => void;
}) {
  const t = useT();
  const [declined, setDeclined] = useState(false);
  const { policy, role, model } = candidate;
  const proposed = Math.min(model.maxOutputTokens * 2, AGENT_MAX_OUTPUT_TOKENS);
  const save = useMutation({
    mutationFn: async () => {
      // Read current settings only on Yes; the guarded patch prevents stale overwrites.
      const data = await api(`/agent/presets?provider=${policy.provider}`);
      if (!data.canManage) throw new Error(t("tokenLimitPermission"));
      const preset = data.presets?.find(
        (item: RecordData) => item.effort === policy.effort,
      );
      const current =
        role === "supervisor"
          ? preset?.supervisor
          : preset?.specialists?.[role];
      if (
        !preset?.configured ||
        current?.modelId !== model.modelId ||
        current?.maxOutputTokens !== model.maxOutputTokens
      )
        throw new Error(t("tokenLimitStale"));
      return api(
        `/agent/presets/${policy.provider}/${policy.effort}/output-limit`,
        {
          role,
          expectedVersion: preset.version,
          expectedModelId: current.modelId,
          expectedMaxOutputTokens: current.maxOutputTokens,
        },
        "PATCH",
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/agent/presets?provider=${policy.provider}`],
      });
      void queryClient.invalidateQueries({ queryKey: ["/agent/readiness"] });
    },
  });
  if (model.maxOutputTokens >= AGENT_MAX_OUTPUT_TOKENS)
    return (
      <Callout>
        {t("tokenLimitMaximum").replace(
          "{tokens}",
          model.maxOutputTokens.toLocaleString(),
        )}
      </Callout>
    );
  if (declined)
    return (
      <p className="text-ui-sm text-muted-foreground">
        {t("tokenLimitDeclined")}
      </p>
    );
  if (save.isSuccess) return <Callout>{t("tokenLimitSuccess")}</Callout>;
  return (
    <section
      className="flex flex-col gap-stack"
      aria-label={t("tokenLimitAction")}
    >
      <p className="text-ui font-medium">
        {t("tokenLimitQuestion").replace("{tokens}", proposed.toLocaleString())}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        {t("tokenLimitPreset")}: {policy.provider} · {policy.effort} ·{" "}
        {t(
          role === "supervisor"
            ? "tokenLimitSupervisor"
            : role === "source_reviewer"
              ? "tokenLimitSourceReviewer"
              : role === "sound_insulation"
                ? "supervisorSoundInsulation"
                : role === "construction_law"
                  ? "supervisorConstructionLaw"
                  : role === "cost_optimizer"
                    ? "supervisorCostOptimizer"
                    : "tokenLimitRequirementsReviewer",
        )}{" "}
        · {model.modelId}
        <br />
        {model.maxOutputTokens.toLocaleString()} → {proposed.toLocaleString()}{" "}
        {t("tokenLimitTokens")}
      </p>
      <p className="text-ui-sm text-muted-foreground">
        {t("tokenLimitScope")} {t("tokenLimitCaveat")}
      </p>
      <div className="flex flex-wrap gap-stack">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("tokenLimitSaving") : t("tokenLimitYes")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={() => setDeclined(true)}
        >
          {t("tokenLimitNo")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={onDescribe}
          className="h-auto! max-w-full whitespace-normal py-cell"
        >
          {t("tokenLimitDescribe")}
        </Button>
      </div>
      {save.error && (
        <Callout tone="error">
          {save.error instanceof ApiError
            ? save.error.status === 403
              ? t("tokenLimitPermission")
              : save.error.status === 409
                ? t("tokenLimitStale")
                : t("tokenLimitError")
            : save.error.message}
        </Callout>
      )}
    </section>
  );
}
