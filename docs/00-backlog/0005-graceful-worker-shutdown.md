# 0005 — graceful worker shutdown
date:    2026-09-23
state:   done
context: w3 T8 review — WorkerLoop clears its interval in onApplicationShutdown, which Nest runs after PrismaService.onModuleDestroy disconnects; an in-flight tick is not awaited.
value:   on SIGTERM the run being processed stays RUNNING until its lease expires and burns an attempt on reclaim; with F2's long Claude calls this becomes visible on every deploy. Fix: stop the timer in beforeApplicationShutdown and await the current tick.
