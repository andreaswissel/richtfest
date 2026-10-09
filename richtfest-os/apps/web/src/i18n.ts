import en from "./locales/en.json";
import de from "./locales/de.json";
import { usePreferences } from "./store";
export function useT() {
  const language = usePreferences((s) => s.language);
  return (key: keyof typeof en) =>
    (language === "de" ? de : en)[key] || en[key];
}
