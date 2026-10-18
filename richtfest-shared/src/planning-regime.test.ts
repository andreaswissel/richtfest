import { expect, test } from "bun:test";
import { baunutzungsplanCoverage, ordinanceForAdoption, planTypeFromRegister } from "./planning-regime";

test("the BauNVO version follows the adoption date, with the two years after each change flagged", () => {
  expect(ordinanceForAdoption("1961-05-01")).toEqual({ ordinance: null, transitional: false });
  expect(ordinanceForAdoption("1968-12-31")).toEqual({ ordinance: "baunvo_1962", transitional: false });
  expect(ordinanceForAdoption("1977-09-30")).toEqual({ ordinance: "baunvo_1968", transitional: false });
  expect(ordinanceForAdoption("1977-10-01")).toEqual({ ordinance: "baunvo_1977", transitional: true });
  expect(ordinanceForAdoption("1990-01-26")).toEqual({ ordinance: "baunvo_1977", transitional: false });
  expect(ordinanceForAdoption("1990-01-27")).toEqual({ ordinance: "baunvo_1990", transitional: true });
  expect(ordinanceForAdoption("1992-01-27")).toEqual({ ordinance: "baunvo_1990", transitional: false });
  expect(ordinanceForAdoption("2021-13-01")).toEqual({ ordinance: null, transitional: false });
});

test("Baunutzungsplan coverage follows the former border, not today's districts", () => {
  expect(baunutzungsplanCoverage("110000020202")).toBe("covered"); // Kreuzberg
  expect(baunutzungsplanCoverage("110000020201")).toBe("none"); // Friedrichshain, same district
  expect(baunutzungsplanCoverage("110000010102")).toBe("covered"); // Moabit
  expect(baunutzungsplanCoverage("110000010101")).toBe("none"); // Mitte
  expect(baunutzungsplanCoverage("110000080801")).toBe("covered"); // Neukölln
  expect(baunutzungsplanCoverage("110000050504")).toBe("partial"); // Staaken, split by the border
  expect(baunutzungsplanCoverage("110000090901")).toBe("none"); // Alt-Treptow
  expect(baunutzungsplanCoverage(null)).toBe("unknown");
});

test("plan types are read from the register's names", () => {
  expect(planTypeFromRegister("Qualifizierter B-Plan")).toBe("qualified");
  expect(planTypeFromRegister("Einfacher B-Plan")).toBe("simple");
  expect(planTypeFromRegister("Vorhabenbezogener B-Plan")).toBe("project_specific");
  expect(planTypeFromRegister("")).toBeNull();
});
