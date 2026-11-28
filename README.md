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
- **Off-PC copy (owner):** Server → Off-PC copy sends every database to your own Cloudflare R2 / S3 bucket after the nightly backup (`<bucket>/<folder>/<date>/<name>.db`). Add a lifecycle rule on the bucket to delete copies after 30 days.
- **Bad updates undo themselves:** before an update installs, the version it replaces is written to `data/update-pending.json`. If the new version crashes twice or isn't healthy within 4 minutes, Shuttle Control resets to the old version and records it in `data/update-undone.json`; that update is skipped and the next one installs as usual.
- **Server page** (super admins): health checks, live traffic, response times, page speed on real devices, the log, daily reports, backups and restore, cores / memory / bandwidth limits, restart, and **Remove all staff** (keeps super admins and all history).
- **Shuttle Control** (on the PC, `Shuttle Control.bat`): status, live log, start / stop / restart, and the Cloudflare connection with the reason if it can't connect.
- **Privacy:** customer names, phones, addresses and notes are cleared nightly from finished rides. Reports keep only counts, times and cities. Passwords are hashed; secrets (email password, Twilio token, tunnel token) stay on the server.

## Offering it to other businesses
Every business lives at its own path on the website's address: **turaslubtha.com/pinevalley**. Cloudflare only needs **one** route, `turaslubtha.com` → `http://localhost:3000` (plus `www` if you like). No wildcard DNS or wildcard tunnel routes are needed.

| Address | What it is |
|---|---|
| turaslubtha.com | The website |
| turaslubtha.com/demo | Book a demo. Requests show on Manager → Server → Demo requests (super admins get a notification) |
| turaslubtha.com/signin | One sign-in for everyone: email + password, then straight into your own business |
| turaslubtha.com/shuttle | This PC's own shuttle (rename it on Manager → Server → Businesses → This shuttle) |
| turaslubtha.com/<name> | Each other business, its own separate section |

**Add a business (Manager → Server → Businesses on this PC, super admins only):** type its name and web address name, then send the owner the one-time setup link. They make their own manager account and fill in their business.
- Each business gets **its own separate database** (`data/businesses/<name>/shuttle.db`) with its own staff, rides, customers, settings and nightly backups. Sign-ins are kept per business too.
- **Who's on top:** 👑 **Owner** (you: the PC's own shuttle, set by `ADMIN_EMAIL`, share it under People → Edit) sees the server side: Server page, businesses, demo requests, web address. Each business has its own ⭐ **Super admin** (whoever set it up): the top of that business, can change everything in it including other managers, and never sees the server side. Managers can't change super admins.
- **Pause** closes a business until you turn it back on. Nothing is deleted.
- **Set it up for them** (when adding): kind of business, base word, time zone, color, features and limits. **Features & limits** changes them any time (off = hidden and refused). **Open** signs you in to that business as hidden *Turas Lúbtha support* (full access, banner on every page, not in their staff list, no password).
- The shuttle's old address keeps working; **Use it for new links & QR codes** switches new links to turaslubtha.com/<name>.
- `data/directory.db` lists the businesses. Back it up with the rest of `data/`.
- On this PC you can try it without Cloudflare: http://website.localhost:3000/shuttle and http://website.localhost:3000/signin.

**Or give a business its own install** on its own PC (as above). It has its own database, branding, staff and web address, and starts on Setup. Installs update themselves from the repository they were cloned from, so when you publish a new version to `main`, every install picks it up within minutes.

## The driver app
**Turas Lúbtha Driver** (`mobile/`) is a native app for Android and iPhone, built with Flutter. Drivers sign in once (the shared sign-in finds their business) and get:
- **Start shift** with their van, **End shift**.
- **Next stop**: who, where, notes, and one big button for the next step: *On my way → I'm here → Customer is on board → Ride complete*. "Customer didn't come out" after the wait; *Not here yet*, *Give back*, *Cancel ride* (with a reason).
- **Navigate** (Google Maps, to the customer or back to the business), **Call** and **Text** the customer (through the business's number when Settings → Phone & email says so).
- **Rides**: my rides in order, and rides waiting for a driver (take one).
- **Ride offers** with a countdown: Take it / No thanks.
- **The van's location keeps sending while on shift**, also with the screen off or Maps in front (Android shows an "On shift" notice; iPhone the blue location indicator). It stops when the shift ends.
- **Phone notifications** for new rides and ride offers while on shift.
- **Managers, advisors and BDC** sign in too. Managers can drive (start a shift, run rides). Managers and advisors get a **Desk** tab: **Book a ride** (customer, address search, when, details, then text them the tracking link), every open ride, assign or move drivers, cancel, call or text, drivers on shift, and **Full manager site** (the whole website inside the app, already signed in).

**Builds (GitHub → Actions → *Driver app*):** every change to `mobile/` checks and tests the app and builds it; **Run workflow** builds on demand.
- **Android:** download *turas-driver-android* → `turas-driver.apk`, send it to the phone and open it (allow "install unknown apps"). For **Google Play**: a Play developer account ($25 once), an upload key (`keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`) and the repository secrets `ANDROID_KEYSTORE_BASE64` (the .jks, base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; each build then also makes `turas-driver.aab` to upload.
- **iPhone:** the build checks the app on a Mac. To put it on iPhones (TestFlight or the App Store) it needs an Apple Developer account ($99/year); signing is then added to the workflow.

**Working on the app:** `cd mobile && flutter test` (Flutter 3.47). `dart run tool/e2e.dart http://website.localhost:3000 <driver email> <password>` runs a whole ride against a real shuttle server. Screenshots: `flutter build web --dart-define=DEMO=true` (made-up data; `?screen=signin|shift|today|here|offer|rides|me`).

**No app store needed:** turaslubtha.com/driver still installs the web version on any phone's home screen.

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
