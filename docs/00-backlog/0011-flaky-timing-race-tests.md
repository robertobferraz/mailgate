# 0011 — Timing-based race tests in the inbound int specs can flake
date:    2026-09-24
state:   open
context: f6-hardening w2 — processor.int-spec race tests sleep 100ms against a 300ms fake classifier delay; one full test:int run failed 5 tests, the next two passed 80/80
value:   a red CI run that passes on retry erodes trust in the suite; replace sleeps with a latch the fake releases on demand
