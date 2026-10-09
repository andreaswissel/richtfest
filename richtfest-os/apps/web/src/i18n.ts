import en from "./locales/en.json";
import de from "./locales/de.json";
import { usePreferences } from "./store";
export function useT() {
  const language = usePreferences((s) => s.language);
  return (key: keyof typeof en) =>
    (language === "de" ? de : en)[key] || en[key];
}

export function projectStatusLabel(
  status: string | null | undefined,
  t: ReturnType<typeof useT>,
) {
  const key = {
    planning: "projectStatusPlanning",
    active: "projectStatusActive",
    completed: "projectStatusCompleted",
  }[status || ""] as keyof typeof en | undefined;
  return key ? t(key) : status || t("active");
}
