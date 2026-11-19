# Shuttle 3 redesign: progress

The rebuild lives on the `redesign` branch and is **not live**. Nothing goes to
`main` until the owner reviews it and says "merge it".

Sketches: https://claude.ai/artifact/EjQJrNWfQ92zrnzwAhsxzh

Goal: simple, calm, one clear next step per screen. Every feature and all data
stay; only the layout and look change. No build step.

## Plan

| Day | Step | Status |
|---|---|---|
| 1 | Shared look (colors, type, buttons, chips, cards, forms, tabs, windows) and the shared app frame (side menu on a computer, top bar + bottom bar on a phone, account menu under your name) | Done |
| 2 | Driver, customer tracking, request a ride, watch-only map | Next |
| 3 | Advisor desk and BDC | |
| 4–5 | Manager: overview, rides, reports, people, vehicles, settings as short topic pages, Server | |
| 6 | Sign in, setup, password reset; full test run and browser check at phone and computer sizes; hand over for review | |

## Day 1 notes

- One look for everyone. Your color (Manager → Settings → Branding) is the only
  accent; status colors are fixed (on the way blue, waiting amber, done green,
  urgent red). Red no longer doubles as the button color.
- The old Classic / Branded look switch no longer changes anything. It gets
  removed from Settings on Day 4–5 (the saved setting is kept, just unused).
- Type: Inter if the device has it, otherwise the device's own interface font
  (Segoe UI on Windows, San Francisco on iPhone). Bundling Inter needs a new
  package; that install was not allowed in the session, so it's left out for now.
  The Barlow font preload was dropped since nothing uses it anymore.
- App frame: `#topbar` is now the side menu (computer) / top bar (phone).
  Pages links (Manager, Advisor desk, BDC, Driver) show when you have more than
  one; on a phone they're the bottom bar. Help & ideas, Screen (Auto/Dark/Light),
  Change password, What's new and Sign out are in the menu under your name.
  An empty `#pageNav` slot is ready for each page's own sections (Day 2+).
- Fixed: on a phone, wide content inside a `.grid` could push the page wider
  than the screen.

## Still to do later

- Each page's own layout (Days 2–5) — today's change only restyles them.
- Remove the look switch and "Previewing the … look" pill (Day 4–5).
