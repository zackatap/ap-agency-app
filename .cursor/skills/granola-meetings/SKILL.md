---
name: granola-meetings
description: >-
  Content ideas from Granola meetings for health practice owners. Use the
  agency Content Ideas page or generate API when the user asks to sync meeting
  notes to the content sheet.
---

# Content ideas from Granola

## Agency UI (preferred)

`/agency/content-ideas` — three buttons:

1. **From recent meetings** — last 7 days, 5 ideas
2. **From all meetings** — ~90 days, 5 ideas
3. **Pick meetings** — checkbox picker, 5 ideas

Requires Granola OAuth via **Connect Granola** (once per deploy/workspace).

## Sheet columns

`#`, `Title`, `Type`, `Source`, `Status`, `Hooks`

Defaults: Type `One-time`, Status `Saved`, 3 numbered hooks.

**Title format:** 2 sentences explaining the idea (tactic + payoff/context), not a short headline.

## Hook library

`content/hook-library.md` — merged swipe file + viral templates for chiro/practice owner content.

## CLI fallback

```bash
npm run granola:append -- --file ./ideas.json
```

## Cron

Mon & Thu 9am Chicago (14:00 UTC) via `/api/cron/content-ideas` — recent meetings, 5 ideas.

## Avatar

Health practice owners (mostly chiros). Digital marketing: Meta ads, lead quality, GHL, systems, automations, growth tips.
