# Initial evidenced ingredient functions

Two COLORANT facts only: MICA and CI 77891. IDs and exact canonical names are
copied from the existing published dictionary artifact. Its explicit Titanium
Dioxide alias identifies CI 77891. FDA's [official cosmetic color-additives
table](https://www.fda.gov/cosmetics/cosmetic-ingredient-names/color-additives-permitted-use-cosmetics)
lists mica and titanium dioxide as color additives. Checked 2026-09-20.

The stored jurisdiction is US. This is evidence of a reference ingredient
function, NOT a global regulatory approval, a finished-product safety assessment,
a claim about effectiveness, concentration, purity, particle size, suitability
for eyes or use in another jurisdiction. FDA points to individual regulations
for specifications and restrictions; this seed does not encode compliance rules.
The function may not be the only role in a particular formulation. No other
ingredients receive inferred functions. Iron-oxide CI IDs are intentionally not
mapped from the generic FDA name without separate primary mapping evidence.

No copied prose or tables are embedded. These are attributed factual mappings,
not a third-party dataset redistribution or AI-generated ingredient science.

## Publication

Run inside a built server image with the production environment injected by the
operator. Neither command loads secrets from arguments or modifies the dictionary.

```sh
node apps/server/dist/cli/seed-ingredient-knowledge.js --dry-run
node apps/server/dist/cli/seed-ingredient-knowledge.js --apply
```

Default is dry-run. Requires the exact published dictionary version. JSON is
strict, UTF-8, <=256 KiB, <=100 facts, <=10 evidence links per fact. Evidence is
validated by the domain publication validator. SQL is parameterized and writes
are serialized by advisory transaction lock. Publication is atomic and replay
compares stored facts/evidence rather than trusting the version string. A changed
version cannot replace an active knowledge snapshot: it returns a conflict.

This initial-only command deliberately has no retire/delete/replacement option.
Published knowledge is immutable; future extensions need an explicit reviewed
successor snapshot, not silent merging or loss of previous facts. No production
write or executable verification is implied by the presence of this seed.
