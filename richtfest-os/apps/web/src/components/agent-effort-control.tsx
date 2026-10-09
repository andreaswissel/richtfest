import { list, type RecordData } from "../api";
import { useT } from "../i18n";
import { NativeSelect } from "./ui/native-select";
import { Field } from "./ui/primitives";

/**
 * Compact effort selector for the project composer and agent assignment form.
 * The caller owns the provider/preset query so it can keep navigation within
 * the existing request budget; this control only renders configured options.
 */
export function AgentEffortControl({
  enabled,
  presets,
  value,
  onChange,
}: {
  enabled?: boolean;
  presets?: unknown;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const configured = list(presets).filter((preset) => preset.configured);
  if (!enabled || !configured.length) return null;
  return (
    <Field label={t("supervisorEffort")}>
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)}>
        {configured.map((preset: RecordData) => (
          <option key={preset.effort} value={preset.effort}>
            {t(`effort_${preset.effort}` as never)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
