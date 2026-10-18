import { useEffect, useState, type ComponentProps } from "react";
import { usePreferences } from "../../store";
import { Input } from "./input";

type Language = "en" | "de";
const patterns: Record<Language, { placeholder: string; separator: string }> = {
  en: { placeholder: "dd/mm/yyyy", separator: "/" },
  de: { placeholder: "tt.mm.jjjj", separator: "." },
};

/** ISO date (yyyy-mm-dd) shown in the app language, independent of the browser's locale. */
export const formatDateInput = (iso: string | null, language: Language) => {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? [match[3], match[2], match[1]].join(patterns[language].separator) : "";
};

/** Accepts day-first dates in the app language or ISO; rejects impossible dates instead of rolling them over. */
export function parseDateInput(text: string): string | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dayFirst = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : dayFirst ? [dayFirst[3], dayFirst[2], dayFirst[1]] : [];
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined;
  return date.toISOString().slice(0, 10);
}

export function DateInput({ value, onValueChange, onBlur, ...props }: Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & {
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const language = usePreferences((s) => s.language);
  const [text, setText] = useState(() => formatDateInput(value, language));
  useEffect(() => {
    // Keep a partly typed date; replace the text only when the stored value or language changes it.
    if (parseDateInput(text) !== value) setText(formatDateInput(value, language));
  }, [value, language]);
  const parsed = parseDateInput(text);
  return (
    <Input
      {...props}
      inputMode="numeric"
      autoComplete="off"
      placeholder={patterns[language].placeholder}
      aria-invalid={parsed === undefined || props["aria-invalid"] === true}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = parseDateInput(event.target.value);
        if (next !== undefined && next !== value) onValueChange(next);
      }}
      onBlur={(event) => {
        if (parsed !== undefined) setText(formatDateInput(parsed, language));
        onBlur?.(event);
      }}
    />
  );
}
