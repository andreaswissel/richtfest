import { create } from "zustand";
export const usePreferences = create<{
  language: "en" | "de";
  density: "dense" | "normal";
  theme: "light" | "dark";
  setLanguage: (language: "en" | "de") => void;
  setDensity: (density: "dense" | "normal") => void;
  setTheme: (theme: "light" | "dark") => void;
  hydrate: (preferences: { language?: "en" | "de"; density?: "dense" | "normal"; theme?: "light" | "dark" }) => void;
}>((set) => ({
  language: "en",
  density: "dense",
  theme: "light",
  setLanguage: (language) => set({ language }),
  setDensity: (density) => set({ density }),
  setTheme: (theme) => set({ theme }),
  hydrate: (preferences) => set((current) => ({
    language: preferences.language ?? current.language,
    density: preferences.density ?? current.density,
    theme: preferences.theme ?? current.theme,
  })),
}));
