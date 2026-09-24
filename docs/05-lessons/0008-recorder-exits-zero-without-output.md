# 0008 — a recorder can exit 0 without writing its output
date:  2026-09-24
what broke: `vhs docs/demo/terminal.tape` printed "Creating docs/assets/demo-terminal.gif..." and exited 0, but never wrote the file. Under `set -euo pipefail` the recording script still passed, and `ls docs/assets/demo-*.gif` matched the other GIF.
why:   vhs captures frames from headless Chrome over CDP. On this host the frame buffer stayed empty, and vhs skips encoding without reporting an error.
how to avoid: a script that generates artifacts checks each artifact it promises (`test -s <file>`) before it reports success. Don't trust the exit code of a generator you don't control.
cost:  about half an hour of an implementer's time isolating vhs (ttyd, CDP, ffmpeg) before the tool was dropped (adr 0014).
