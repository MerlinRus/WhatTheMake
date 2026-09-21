# Passive provider quota monitor

The CLI reports admitted invocations, not invoices. `monetaryCost` is always
`null`: no verified pricing or billing reconciliation is implemented. It never
calls Google Vision, DeepSeek or UPCitemdb to check their health, and does not
print credentials, input text, images, identifiers of customers or API payloads.

Run against the active production container:

```sh
docker exec whatthemake-web-1 node /app/apps/server/dist/cli/provider-status.js --json
```

Add `--maintain` to delete one expired budget-history batch (at most 1000
reservations and 100 day records). Current UTC day plus the previous 29 UTC days
remain. The three provider spacing-state records are never purged. No quota is
refunded, and current-day usage survives restarts. Raising a configured quota
takes effect on the next UTC day; lowering it affects the next admission.

Exit codes: `0` no configured warning condition; `2` warning; `1` check failed.
Warnings: enabled provider quota at least 80% used or exhausted, any recorded
authentication/permission error today, or at least three completed provider
failures today (caller aborts excluded). These are daily cumulative indicators,
not a claim of consecutive failures or a fresh provider outage. A recovered
provider can retain a warning until the next UTC day.

`unresolvedCount` includes active requests and admissions whose completion was
not recorded; no age is available, so the report does not label these hung.
No admissions means no health evidence, not provider health. DeepSeek is marked
`DORMANT_NO_CUSTOMER_CALLER`: configured, but the current application has no
customer-facing caller. Duration is recorded adapter time, including admission,
not a percentile or an isolated network-latency measurement. API denials before
admission do not appear as charged requests.

After deploying the CLI and migration, copy `provider-monitor.sh` into the
versioned ops directory selected by `/srv/whatthemake/ops/current`, alongside
the backup scripts. Install the units under their production names:

```sh
install -m 0644 /srv/whatthemake/current/deploy/production/provider-monitor.service /etc/systemd/system/whatthemake-provider-monitor.service
install -m 0644 /srv/whatthemake/current/deploy/production/provider-monitor.timer /etc/systemd/system/whatthemake-provider-monitor.timer
systemctl daemon-reload
systemctl start whatthemake-provider-monitor.service
systemctl enable --now whatthemake-provider-monitor.timer
systemctl list-timers whatthemake-provider-monitor.timer
journalctl -u whatthemake-provider-monitor.service -n 20 --no-pager
```

The timer runs every fifteen minutes with up to one minute random delay. Exit
`2` is accepted by systemd; the JSON `WARN` entry remains visible in journal.
Failures (`1`) fail the oneshot service. Neither status sends a user notification
or restarts the application. `/ready` keeps its existing database-readiness
meaning, and catalogue/manual INCI features remain usable at exhausted budgets.

To stop the monitor, disable its timer; do not erase budget counters:

```sh
systemctl disable --now whatthemake-provider-monitor.timer
```
