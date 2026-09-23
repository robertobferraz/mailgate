# mailgate

## Register
Product. mailgate is a backend service (NestJS) whose only end-user-facing surface is transactional e-mail: an approval request sent to a manager, and an in-thread clarification reply when their answer can't be parsed. There is no web UI. Design serves a workflow (get an unambiguous APROVO/RECUSO reply fast), not a brand moment.

## Users & purpose
- **Approver (manager)**: receives the e-mail in their normal inbox (Gmail/Outlook/Apple Mail, often on mobile), skims it in a few seconds, and either replies "APROVO"/"RECUSO" or opens it briefly to check the amount/description before deciding. They are busy; the e-mail's job is to put the one number that matters (the amount) and the one action that matters (reply APROVO/RECUSO) in front of them instantly.
- **Requester**: not a direct reader of these e-mails, but their submitted description/summary appears verbatim (escaped) inside them.

## Brand personality
Clear, calm, trustworthy, neutral. This is a compliance/finance-adjacent workflow tool — it must never look flashy, sales-y, or persuasive. The agent's recommendation is shown but must stay visually neutral (no green/red) so it doesn't nudge the human's decision.

## Anti-references
Not a SaaS marketing e-mail (no gradient hero, no big CTA button chrome, no logo lockup, no social links/footer bloat). Not playful. Not dark-mode-drenched. Think "bank statement / calendar invite" restraint, not "product update newsletter."

## Accessibility & constraints
- E-mail-client safe only: inline styles, table-based structure, no external CSS/fonts/images, no `<style>` blocks.
- WCAG AA: body text ≥4.5:1 contrast, including secondary/signature text.
- max-width ~600px, legible on mobile without zooming.
- pt-BR copy, fixed by existing tests — layout/color changes only, no copy changes.

## Color strategy
Restrained: near-black ink on white, one small warm-neutral accent reserved for the amount and the reply instruction (the two things the approver must not miss). No brand logo/hero — the accent is functional, not decorative.
