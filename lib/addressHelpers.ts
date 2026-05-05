export type ZipCityState = {
  city: string;
  state: string;
};

export const stateAbbreviations = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY"
];

export const zipCityStateLookup: Record<string, ZipCityState> = {
  "63026": { city: "Fenton", state: "MO" },
  "63088": { city: "Valley Park", state: "MO" },
  "63090": { city: "Washington", state: "MO" },
  "63101": { city: "St. Louis", state: "MO" },
  "63102": { city: "St. Louis", state: "MO" },
  "63103": { city: "St. Louis", state: "MO" },
  "63104": { city: "St. Louis", state: "MO" },
  "63105": { city: "Clayton", state: "MO" },
  "63110": { city: "St. Louis", state: "MO" },
  "63118": { city: "St. Louis", state: "MO" },
  "63122": { city: "Kirkwood", state: "MO" },
  "63123": { city: "Affton", state: "MO" },
  "63129": { city: "Oakville", state: "MO" },
  "63301": { city: "St. Charles", state: "MO" },
  "63303": { city: "St. Charles", state: "MO" },
  "63304": { city: "St. Charles", state: "MO" }
};

export function normalizeZipCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 5);
}

export function normalizeStateValue(value: string) {
  return value.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
}

export function getCityStateForZip(value: string) {
  return zipCityStateLookup[normalizeZipCode(value)] ?? null;
}
