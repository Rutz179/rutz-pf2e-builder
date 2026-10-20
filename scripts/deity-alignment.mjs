// Display-only historical alignments. Never infer alignment from sanctification.
// Source: foundryvtt/pf2e tag 5.7.4, packs/deities/*.json (20 core deities).
// https://github.com/foundryvtt/pf2e/tree/5.7.4/packs/deities
// Stable item IDs also cover translated mirror packs. Homebrew may supply its own flag.
const LEGACY_BY_ID = {
  "d56paSkcwvll2OhR": "LN",
  "QRkcFciCOmFoxF1B": "LE",
  "AlL9GtlTldbqNoVm": "CN",
  "v67fHklTZ6LoU54q": "CG",
  "JgqH3BhuEuA4Zyqs": "CG",
  "mm1j6UbHqFCI8fwB": "LG",
  "88vRw2ZVPax4hhga": "CN",
  "swwwP7eVmlNuWTb7": "N",
  "eErEiVmBqltYXFJ6": "LG",
  "qqqrbq4uCrelQvgH": "LN",
  "aipkJQxP4GBsTaGq": "CE",
  "9EKyWmjLUu42evxC": "N",
  "GX6PF9ifR47Xyjg9": "NE",
  "QZD0u1jxwz0kj8uI": "N",
  "Bhxji0kxIbMKqdkw": "CE",
  "BNycwu3I21dTh4D9": "NG",
  "gxwmzxUWBOhdgFSN": "NG",
  "sZrdzh0ANQnZGXJb": "LG",
  "22n3N47sqbqbDxbp": "NE",
  "ZfN7jkK6boU1FuiS": "LE"
};

export function moralAxis(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (["LG", "NG", "CG", "G", "GOOD", "선"].includes(code)) return { axis: "good", code };
  if (["LE", "NE", "CE", "E", "EVIL", "악"].includes(code)) return { axis: "evil", code };
  if (["LN", "N", "TN", "CN", "NEUTRAL", "중립"].includes(code)) return { axis: "neutral", code };
  return null;
}

export function deityAlignment(entry) {
  if (entry?.type !== "deity") return null;
  const system = entry.system ?? {};
  const override = entry.flags?.["rutz-pf2e-builder"]?.alignment;
  // An explicit empty override suppresses historical fallback for homebrew copies.
  if (override !== undefined) return moralAxis(override);
  const own = typeof system.alignment === "string" ? system.alignment : system.alignment?.own ?? system.alignment?.value;
  if (own !== undefined) return moralAxis(own);
  const source = entry._stats?.compendiumSource ?? entry.flags?.core?.sourceId;
  const sourceId = /Compendium\.pf2e\.deities\.(?:Item\.)?([^.]+)$/.exec(source ?? "")?.[1];
  return moralAxis(LEGACY_BY_ID[sourceId ?? entry.id ?? entry._id]);
}
