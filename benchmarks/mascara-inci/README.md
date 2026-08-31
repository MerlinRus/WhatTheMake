# Mascara INCI benchmark

This directory contains the reviewed engineering gate for mascara ingredient
parsing and dictionary normalization. `corpus-v1.json` keeps exact source text,
GTIN-level provenance, retrieval timestamps, quality flags, exhaustive parser
component anchors, and independent review metadata.

The source records come from
[Open Beauty Facts](https://world.openbeautyfacts.org/) under ODbL 1.0. No
photos, reviews, ratings, prices, or safety/function claims are copied into this
benchmark.

Run the gate with:

```sh
npm run --silent benchmark:inci
```

The command exits successfully only when the corpus is valid, the exact
production dictionary checksum matches, every parser component is covered, and
all quality thresholds pass.
