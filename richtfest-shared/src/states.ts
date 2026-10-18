/** German federal states (Länder) by their common two-letter code. The order follows the official state key (AGS 01–16) only in `STATE_BY_KEY`. */
export const STATE_CODES = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] as const;
export type StateCode = (typeof STATE_CODES)[number];

export const STATE_NAMES: Record<StateCode, string> = {
  BW: "Baden-Württemberg", BY: "Bayern", BE: "Berlin", BB: "Brandenburg", HB: "Bremen", HH: "Hamburg", HE: "Hessen", MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen", NW: "Nordrhein-Westfalen", RP: "Rheinland-Pfalz", SL: "Saarland", SN: "Sachsen", ST: "Sachsen-Anhalt", SH: "Schleswig-Holstein", TH: "Thüringen",
};

/** Official state key (first two digits of the Amtlicher Gemeindeschlüssel) -> state code. */
export const STATE_BY_KEY: Record<string, StateCode> = {
  "01": "SH", "02": "HH", "03": "NI", "04": "HB", "05": "NW", "06": "HE", "07": "RP", "08": "BW",
  "09": "BY", "10": "SL", "11": "BE", "12": "BB", "13": "MV", "14": "SN", "15": "ST", "16": "TH",
};

export const isStateCode = (value: string): value is StateCode => (STATE_CODES as readonly string[]).includes(value);
