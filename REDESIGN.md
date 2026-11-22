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
| 2 | Driver, customer tracking, request a ride, watch-only map | Done |
| 3 | Advisor desk and BDC | Done |
| 4–5 | Manager: overview, rides, reports, people, vehicles, settings as short topic pages, Server | Done |
| 6 | Sign in, setup, password reset; full test run and browser check at phone and computer sizes; hand over for review | Done |

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

## Day 2 notes

- `App.pageNav(title, items, onShow)` gives a page its own sections. Elements
  carry `data-views="today me"`; the section is in the address (`#rides`) so
  Back works. On a computer the sections are in the side menu; on a phone they
  take over the bottom bar and links to your other pages move into the menu
  under your name.
- Driver: **Today** (location bar, start-shift card when off shift, one big
  "next stop" card with Navigate / Call / Text and one big button for the next
  step, then "After that"), **Rides** (route planner, Mine / Unassigned / All
  open, pick up / drop off filter), **Map**, **Me** (shift, alerts, keep screen
  on, end shift, photo, lock-screen alerts). Every old button is still there:
  Take this ride, Start, I'm here, on board, complete, no-show, Not here yet,
  Give back, Cancel. The ride offer pop-up sits above the bottom bar.
- Customer tracking: live map on top, one card with "Hi Kai, Sam is on the
  way", a big arrival time in your color, the driver and van, then the steps.
  Call us / Text us / Add to calendar as buttons; I'm running late, Share and
  Cancel ride as a quiet row of links.
- Request a ride: same steps, quieter header, line-drawn arrows.
- Watch-only map: light header so your logo shows.

## Day 3 notes

- Advisor desk sections: **Queue**, **At the dealership** (the count shows in
  the menu when someone is waiting for their ride back), **Map & drivers**.
- Queue: compact rows (`Rides.row`) with position, customer, pick up / drop
  off and address, status, driver, and time. On a computer (1100 px and wider)
  the picked ride shows on the right with every action (assign driver, send
  link, edit, cancel); on a smaller screen tapping a row opens it in a window.
  The wait meter and the type filter / My customers only sit above the list.
  Cancelled today folds away under the queue.
- **New ride** opens the same step-by-step form in a side panel. Closing it
  keeps what was typed; after booking it closes and shows the new ride.
- A "booked for you" note's **Show it** picks that ride.
- BDC: a clear "Customer calls" header, quieter "Tell them" line; the
  call-first layout (find, book, today / booked ahead / finished) is unchanged.
- Step-by-step forms: Next is in your color now (was black).

## Days 4–5 notes

- Manager sections are in the side menu (bottom bar on a phone, scrolls
  sideways): Overview, Rides, Reports, People, Vehicles, QR codes & links,
  Settings, and Server (super admins only). Each has a page title.
- Settings is short pages by topic, each at its own address
  (`#settings/branding`): Business, Rides & customers, Drivers, Privacy &
  sign-in, Branding, Phone & email, Web address, Help & extras. Business /
  Rides / Drivers / Privacy are still one form saved together (only the
  matching fields show), so nothing about saving changed.
- The Classic / Branded switch and its preview links are gone. The saved
  value is kept in a hidden field. Any old "preview" choice on a device is
  forgotten, and its pill no longer shows.
- `App.pageNav` understands sub-pages (`#settings/phone`).

## Day 6 notes

- Sign in, password reset and setup use the new look (light header, your
  logo on a white card). Setup lost an old gray subtitle color.
- A page that sends you elsewhere (not signed in, or the wrong role) now just
  goes, instead of logging a "redirect" error.
- Spectator links table scrolls inside its card on a phone.
- Version 3.0.0 with "What's new" notes; README says Manager and Settings pages.
- Full browser check: 143 page views (every page and settings page, as a
  manager, advisor, BDC and driver, signed out, phone and computer, light and
  dark): no script errors, no failed requests, nothing wider than the screen.
  `npm test`: 92 of 92 pass.

## Ready for review

Not merged and not live. When the owner says "merge it", this branch goes to
`main` and the shuttle PC updates itself as usual.

## Still to do later

- Each page's own layout (Days 2–5) — today's change only restyles them.
