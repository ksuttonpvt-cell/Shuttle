# Shuttle

Dispatch and live tracking for a business shuttle: a car dealership's service shuttle, or a hotel, airport-parking, office or event shuttle. Advisors (or a front desk) book rides, drivers see what to do next on their phone, admins run the fleet and staff, and customers follow their ride live from a text link or QR code, like a ride app.

Every install is its own business: its own name, logo, colors, app icon, web address, staff and data. A new install starts blank and opens on a **Setup** page.

## What's in it

| Page | Who | What they do |
|---|---|---|
| **Manager** `/admin` | Managers | Live dashboard and map, ride history, reports, staff and roles, vehicles, QR codes and links, phone & email, branding, settings. Super admins also get the **Server** page. |
| **Advisor desk** `/advisor` | Service advisors / front desk | Book pick ups and drop offs step by step, see the ranked shuttle queue and live vans, assign drivers, send tracking links. |
| **BDC desk** `/bdc` | Phone team | Find a customer's ride by name, phone or RO number while on the phone, book rides for an advisor, tell callers the current wait. |
| **Driver app** `/driver` | Drivers (phone) | Start a shift in a van, share GPS, “Do this next”, ride offers, route planner, **I'm here**, Navigate / Call / Text. |
| **Request a ride** `/request` | Customers | Request a pick up or drop off (can be turned off), with the current wait shown. |
| **Tracking** `/t/<code>` | The customer | Driver photo, van and plate, stops before them, live map and countdown, “Your shuttle is here”, running late / cancel. |

Highlights:
- **Smart queue and routes:** urgent and overdue rides first, routes that stop at your base mid-trip, seat limits, rotation offers for drivers near the base, real road times (OpenStreetMap / OSRM).
- **Ride-app touches:** driver card, “N stops before you”, arrival alert with a wait timer and no-show, a live wait estimate for staff and customers.
- **Roles:** manager, advisor, BDC and driver (plus super admins, who also get the Server page), with several roles per person. Managers can delete accounts; history keeps everyone's names.
- **Phone & email your way:** staff use their own phones, or a business number (Twilio) for calls and texts that hides personal numbers; your own email account for password links and confirmations.
- **Reports:** per driver and van (shifts, hours, miles, drive and wait times, no-shows), busiest hours, a downloadable ride log, and a daily shuttle + server report.
- **Runs itself:** uses every processor core, installs updates on its own, backs up every night, clears customer details every night, and comes with **Shuttle Control** for the PC it runs on.

## Install

Requires **Node.js 22.13 or newer** (the database is Node's built-in SQLite; nothing else to install) and **Git**.

### On a Windows PC (with a Cloudflare Tunnel for the web address)
1. Install **Node.js** (LTS) from nodejs.org and **Git** from git-scm.com.
2. In PowerShell:
   ```powershell
   cd C:\
   git clone <this repository's address> Shuttle
   cd Shuttle
   npm install --omit=dev
   copy .env.example .env
   ```
3. Double-click **start-shuttle.bat**. The window shows a **setup code**. Open http://localhost:3000. It goes to **Setup** (below).
4. To reach it from phones, use a **Cloudflare Tunnel** (free, HTTPS, no router changes). In Cloudflare: **Zero Trust → Networks → Tunnels → Create a tunnel**. Copy the install command it shows and paste it into **Shuttle Control.bat → Cloudflare → tunnel token**. Shuttle Control then runs and reconnects the tunnel. Add a **Public hostname** (for example `shuttle.yourbusiness.com` → `http://localhost:3000`), then enter that address in **Manager → Settings → Web address** and tap **Check**.
5. To start it with Windows, put **start-shuttle-hidden.vbs** in the Startup folder (`shell:startup`), or make a Task Scheduler task “At startup” that runs `start-shuttle.bat`. Only one copy ever runs: a second start just says it's already running. Set the PC to never sleep.

### In the cloud
- **Render:** New → Blueprint → this repository (`render.yaml`). Render asks for the first admin's email, name and password. Sign in, and Setup opens for the business details.
- **Docker:** a `Dockerfile` is included. Mount a volume for `/data` and serve it over HTTPS.

### Setup (first visit)
A new install opens **/setup**:
1. **Your manager account**, with the **setup code** from the server window or log. That way only the person who installed it can claim it. If the first admin came from `ADMIN_EMAIL` in `.env`, they sign in instead and skip this step.
2. **Your business:** car dealership or shuttle service, name, phone, and what riders call your base (dealership, hotel, office…).
3. **Where the shuttle starts:** the address on a map, and the time zone.
4. **Colors.** Then the Manager page opens. Add vehicles and staff, and optionally a logo, app icon, banner, texting and email.

Want sample data to try it? `npm run seed:demo` adds a few vans, staff (password `shuttle123`) and rides.

## The Turas Lúbtha website
The public website lives in `site/` and is served by this same program when it's visited as **turaslubtha.com** (preview on the PC: http://website.localhost:3000). Those visits only get the website, never the shuttle app. See `site/README.md`.

## Make it yours (Manager → Settings)
Settings is a set of short pages: Business, Rides & customers, Drivers, Privacy & sign-in, Branding, Map, Phone & email, Web address, and Help & extras.
A new install has no branding: plain colors, a plain icon, and “Your logo” placeholders where a logo goes, until you add yours here.
- **Business:** dealership or shuttle service, name, address, phone, and the word for your base. Drivers and customers see that word everywhere, including route stops, texts and emails.
- **Branding:** name, your color, logo (and a second logo for light backgrounds), **app icon** (browser tab, phone home screen, notifications) and a **banner** photo for the sign-in and customer pages. Every browser tab shows your name.
- **Map:** OpenStreetMap (free, no account), Mapbox, MapTiler, Stadia Maps, Thunderforest or Google Maps (Map Tiles API). Each keyed service has a key box, how-to and Test; restrict keys to your web address at the provider. Maps fall back to OpenStreetMap if the chosen service fails.
- **Web address:** your own address, with a **Check** that confirms it reaches this site. Links, texts, emails and QR codes use it. There's also an optional short request link like `/ride`.
- **Phone & email** (its own page under Settings):
  - **Calls and texts:** from staff's own phones, or through a business number. With the business number, Call rings the staff member's phone and connects them; Text sends from that number and saves the message on the ride.
  - **Customers and incoming calls:** choose which number customers see, and who calls to the shuttle number ring (the driver on that customer's ride, drivers on shift, or a desk phone).
  - **Email:** a shared mailbox from your own email system. Staff members' own addresses aren't accepted. Choose which emails go out and who gets the daily report.

## Running it
- **Updates:** the site checks its Git repository every 5 minutes (`AUTO_UPDATE`, `UPDATE_CHECK_MINUTES`). When a new version is there, it installs it and restarts in a few seconds, and open screens switch over by themselves. If an update changes Shuttle Control itself (the part that runs the site and the Cloudflare connection), it restarts itself too, so fixes there apply without a manual restart. Manager → Server shows the version and has **Check for updates now**.
- **Every night at midnight:** the day's report is saved, finished rides older than **Keep customer info for** (Settings → Privacy & sign-in, 30 days by default) lose their customer details, then the database is backed up (kept 14 days, in `data/backups`; any backup can be restored from Manager → Server).
- **Server page** (super admins): health checks, live traffic, response times, page speed on real devices, the log, daily reports, backups and restore, cores / memory / bandwidth limits, restart, and **Remove all staff** (keeps super admins and all history).
- **Shuttle Control** (on the PC, `Shuttle Control.bat`): status, live log, start / stop / restart, and the Cloudflare connection with the reason if it can't connect.
- **Privacy:** customer names, phones, addresses and notes are cleared nightly from finished rides. Reports keep only counts, times and cities. Passwords are hashed; secrets (email password, Twilio token, tunnel token) stay on the server.

## Offering it to other businesses
**Host them on this PC (Manager → Server → Businesses on this PC, super admins only).** Type the business name and pick its web address (`pinevalley` → **pinevalley.turaslubtha.com**), then send the owner the one-time setup link. They make their own manager account and fill in their business on the usual Setup page.
- Each business gets **its own separate database** (`data/businesses/<name>/shuttle.db`) with its own staff, rides, customers, settings and nightly backups (`data/businesses/<name>/backups`). Nothing is shared with this shuttle or with any other business.
- Business owners are managers of their own business only. They can never open the Server page, because it runs the whole PC.
- **One sign-in for everyone: app.turaslubtha.com** (also the website's Sign in page). People type their email and password and land straight in their own business. Someone at more than one business picks which one. It never says which emails or businesses exist.
- **Pause** closes a business until you turn it back on. Nothing is deleted.
- `data/directory.db` only lists the businesses. Back it up with the rest of `data/`.

One-time Cloudflare setup, so every business address reaches this PC:
1. **DNS** for turaslubtha.com: add a **CNAME** named `*` pointing to your tunnel (`<tunnel-id>.cfargotunnel.com`, proxied, orange cloud).
2. **Zero Trust → Networks → Tunnels →** your tunnel **→ Public hostnames → Add**: subdomain `*`, domain **turaslubtha.com**, service **HTTP**, URL **localhost:3000**.

This also covers app.turaslubtha.com. **Trying it before turaslubtha.com is set up:** businesses also work under the shuttle's own web address (Manager → Settings → Web address), e.g. pinevalley.corwinshuttleservice.com and app.corwinshuttleservice.com. Do the same two Cloudflare steps for that domain. On this PC you can try it without Cloudflare: http://app.localhost:3000 and http://<name>.localhost:3000.

**Or give a business its own install** on its own PC (as above). It has its own database, branding, staff and web address, and starts on Setup. Installs update themselves from the repository they were cloned from, so when you publish a new version to `main`, every install picks it up within minutes.

## Settings file (`.env`)
| Setting | Default | What it's for |
|---|---|---|
| `PORT` | `3000` | The site's port on this computer |
| `CONTROL_PORT` | `3001` | Shuttle Control's port (this PC only) |
| `DB_FILE` | `data/shuttle.db` | The database (backups go next to it) |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | — | Optional first admin. Without them, Setup makes one. |
| `PUBLIC_URL` | from the request | Web address for links. Manager → Settings → Web address wins. |
| `AUTO_UPDATE` / `UPDATE_CHECK_MINUTES` | `1` / `5` | Automatic updates |
| `CORES` / `RAM_MB` | auto | Processor cores and memory limit. These win over Manager → Server. |
| `SMTP_*`, `TWILIO_*` | — | Email and phone. Usually set in Manager → Settings → Phone & email. These win. |
| `CLOUDFLARE_TUNNEL_TOKEN` / `TUNNEL_PROTOCOL` | — | Set from Shuttle Control |
| `ROUTING=off` | — | Use straight-line estimates instead of road times |
| `BUSINESS_DOMAIN` | `turaslubtha.com` | Hosted businesses live at `<name>.` this; the shared sign-in is `app.` this |

Maps and address search use OpenStreetMap (no API key).

## Tests
```bash
npm test
```
