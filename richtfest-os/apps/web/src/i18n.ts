import en from "./locales/en.json";
import de from "./locales/de.json";
import type feasibility from "./components/feasibility/locales/en.json";
import type buildingModel from "./components/building-model/locales/en.json";
import { usePreferences } from "./store";

type Key = keyof typeof en | keyof typeof feasibility | keyof typeof buildingModel;
type Messages = Record<string, string>;
const messages: Record<"en" | "de", Messages> = { en: { ...en }, de: { ...de } };

/**
 * Adds a screen's strings when its route chunk loads, so the boot bundle carries only shell strings.
 * Route chunks register at module evaluation, before the router renders them.
 */
export function registerMessages(screen: { en: Messages; de: Messages }) {
  Object.assign(messages.en, screen.en);
  Object.assign(messages.de, screen.de);
}

export function useT() {
  const language = usePreferences((s) => s.language);
  return (key: Key) => messages[language][key] || messages.en[key]!;
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
