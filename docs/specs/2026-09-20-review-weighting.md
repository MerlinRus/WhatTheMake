# Review weighting v3

Only source-attributed, current aggregates for the exact published variant enter
comparison. Private packaging snapshots never inherit a catalog rating.

The effective sample is count × sourceWeight × ageWeight. Source weights are
HIGH=1, MEDIUM=0.6, LOW=0.2. Age weight is 1 up to 365 days and 0.5 up to
730 days; future dates and older aggregates are excluded. An effective sample
below 20 cannot determine a winner.

The ranking score is (rating × effectiveSample + 3.5 × 20) /
(effectiveSample + 20). A lead of at least 0.25 is required, and every eligible
candidate must have sufficient review evidence. This is a transparent product
policy, not a calibrated probability or confidence interval. Raw ratings and
real review counts remain displayed separately.

WTM account reviews have LOW source quality: email and purchase are unverified.
Only the latest approved revision enters the aggregate. Pending, rejected,
deleted and duplicate texts do not increase the sample. LOW evidence can reach
MEDIUM confidence, never HIGH. An edit removes the prior revision from the
aggregate until moderation.

Hard constraints are applied before reviews or price. User price is shown as a
dated packaging observation; a cheaper product is not automatically better.
No synthetic reviews or model-estimated ratings may be inserted into production.
