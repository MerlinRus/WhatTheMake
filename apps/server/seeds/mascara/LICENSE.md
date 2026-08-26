# Open Beauty Facts mascara seed

`seed.json` is an adapted database containing selected product identity fields
from [Open Beauty Facts](https://world.openbeautyfacts.org/). It is made
available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Attribution: Contains information from Open Beauty Facts, made available under
the Open Database License (ODbL) 1.0.

This license applies to the seed data, not to the WhatTheMake application code.
No Open Beauty Facts product photos or review text are included.

When a source record has an empty `brands` field, generation accepts a brand
only when its product name starts with the longest exact brand value explicitly
present in another fetched Open Beauty Facts record. Unmatched records are
discarded.

Generation command for the 2026-08-26 snapshot:

```text
node tools/fetch-open-beauty-facts-mascara.mjs --output apps/server/seeds/mascara/seed.json --dataset-version 2026-08-26 --retrieved-at 2026-08-26T15:00:00.000Z
```
