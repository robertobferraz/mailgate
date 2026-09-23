# 0005 — Manual Claude tool-use loop with append-only history
date:     2026-09-23
status:   active
context:  the agent must pause mid-loop on request_approval and resume in another process hours later. The SDK Tool Runner runs to completion in one process.
decision: write the tool-use loop by hand with @anthropic-ai/sdk messages.create, persist response.content verbatim to runs.messages before executing any tool, and use tool_choice auto with disable_parallel_tool_use and strict tools.
consequences: crash after a tool re-executes the same tool_use_id, so tools must be idempotent (unique constraints). History is append-only (thinking blocks preserved). Default model claude-opus-5 via ANTHROPIC_MODEL with server-side fallback enabled; classifier uses messages.parse with a Zod output format.
source:   workstream mailgate · /sdd start (brainstorm + research) · RESEARCH.md Q4
