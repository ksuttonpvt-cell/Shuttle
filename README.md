# Dealership Shuttle

A shuttle dispatch website for **Corwin Toyota of Boulder**. Service advisors book rides, drivers see what to pick up first, admins run the fleet and logins, and customers get a live tracking link or QR code.

## What's in it

| Section | Who | What they can do |
|---|---|---|
| **Advisor desk** `/advisor` | Service advisors | Book a pick up (customer → dealership) or drop off (dealership → customer) with address search and a map pin. See the ranked shuttle queue, assign drivers, edit or cancel rides, and send the customer a tracking link by text, email, or QR code. |
| **Driver app** `/driver` | Shuttle drivers (phone friendly) | Start a shift in a vehicle, share live GPS, see **“Do this next”**, take unassigned rides, tap through *On my way → On board → Complete*, and use one-tap Navigate, Call, and Text. |
| **Admin** `/admin` | Admins | Live dashboard and map, ride history with CSV export, staff accounts (create, edit, reset password, disable), vehicles (make/model, plate, VIN, seats, mileage, maintenance status), printable QR codes and links, and dealership settings. |
| **Customer request** `/request` | Anyone (can be turned off) | A public form to request a ride. Print its QR code for the service drive. |
| **Customer tracking** `/t/<code>` | The customer | Progress steps, driver first name, which vehicle to look for, place in line, and the driver's position on a map. |

### “What needs to be picked up first”
Every open ride gets a queue number. Ride in progress (on board or en route) come first, then overdue, then urgent, then soonest. When two rides are due about the same time, the one closer to the driver (or the dealership) goes first. Each ride shows why it is in that spot, for example “Late by 5 min · Urgent · 1.2 mi away”. You can change the logic in `src/priority.js`.

### Logins
Each person has their **own email + password** (8+ characters). Passwords are hashed with scrypt, and sign-in is rate-limited. Admins create accounts and reset passwords, and anyone can change their own password from the top bar.

## Run it

Requires **Node.js 22.13 or newer** (the database is Node's built-in SQLite, so nothing else to install).

```bash
npm install
ADMIN_EMAIL=you@yourdealership.com ADMIN_PASSWORD='choose-a-strong-one' ADMIN_NAME='Your Name' npm start
# open http://localhost:3000
```

On first start it creates that admin account. Without `ADMIN_PASSWORD`, it prints a random one in the console.

Want sample data to try it out? Run `npm run seed:demo`. It adds 3 shuttles, an advisor, 2 drivers (password `shuttle123`), and a few rides.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web port |
| `DB_FILE` | `data/shuttle.db` | Database file (back this up) |
| `PUBLIC_URL` | from the request | Address used in QR codes and texted links, e.g. `https://shuttle.example.com` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | First admin account (only used when there are no users yet) |

### Putting it online (Render, about 15 minutes)
1. Merge this repo's pull request into `main`.
2. Create an account at **render.com** and sign in with GitHub, allowing access to this repo.
3. In the Render dashboard, choose **New → Blueprint**, then pick this repo. Render reads `render.yaml`.
4. Render asks for **ADMIN_EMAIL**, **ADMIN_NAME** and **ADMIN_PASSWORD**. That becomes your admin login.
5. Click **Apply**. After a few minutes the site is live at `https://corwin-shuttle.onrender.com` (or a similar address), with HTTPS.
6. Sign in, then go to **Admin → Vehicles** to add the shuttles, **Staff & logins** to add advisors and drivers, and **Settings** to confirm the dealership pin.

Cost: the Starter plan (about $7/month) plus a 1 GB disk (about $0.25/month). The disk is what keeps the rides and accounts saved between restarts. Every push to `main` redeploys automatically.

**Own web address (optional):** in Render, open the service, go to **Settings → Custom Domains**, and add for example `shuttle.yourdealership.com`. Render shows one DNS record for whoever manages the dealership's domain to add. Then set `PUBLIC_URL` to that address under **Environment**, so the QR codes use it. Reprint any QR codes made before the change.

### Running it on your own Windows 11 PC
**1. Install the software (one time).** Install **Node.js** (the "LTS" version) from nodejs.org and **Git** from git-scm.com, accepting the default options.

**2. Get the app.** Open **PowerShell** and run:
```powershell
cd C:\
git clone https://github.com/ksuttonpvt-cell/Shuttle.git
cd Shuttle
npm install --omit=dev
copy .env.example .env
notepad .env
```
In Notepad, fill in your admin email, name and password, plus `PUBLIC_URL` (the web address from step 4), then save.

**3. Try it.** Double-click `C:\Shuttle\start-shuttle.bat`, then open http://localhost:3000 on that PC.

**4. Make it reachable from phones (free, with HTTPS).** Use a **Cloudflare Tunnel**. It needs no router changes and doesn't open any ports.
1. Make a free account at cloudflare.com and add a domain you control. This could be the dealership's domain (ask whoever manages it), or a new one bought through Cloudflare for about $10 a year.
2. In Cloudflare, go to **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, and name it `shuttle`.
3. Choose **Windows**, and run the install command it shows in PowerShell opened with **Run as administrator**. This installs the tunnel as a Windows service that starts on its own.
4. Under **Public hostname**, enter `shuttle` plus your domain. For the service, choose type **HTTP** with URL **localhost:3000**. Save.
5. The site is now at `https://shuttle.yourdomain.com`. Make sure `PUBLIC_URL` in `.env` matches it.

**5. Keep it running after restarts.** Open **Task Scheduler** and choose **Create Task** (not "Basic").
- **General:** name it `Shuttle`, and tick **Run whether user is logged on or not**.
- **Triggers:** New → **At startup**.
- **Actions:** New → Start a program → `C:\Shuttle\start-shuttle.bat`.
- **Settings:** untick **Stop the task if it runs longer than**, and tick **If the task fails, restart every 1 minute**.

Then right-click the task and choose **Run**. Also go to **Settings → System → Power** and set sleep to **Never**.

**Updating later:** in PowerShell, run `cd C:\Shuttle`, then `git pull`, then `npm install --omit=dev`. Then end and run the `Shuttle` task in Task Scheduler.

**Backups:** everything (rides, logins, vehicles) is stored in `C:\Shuttle\data`. Copy that folder somewhere safe regularly, such as a USB drive or OneDrive. The most reliable copy is one made while the task is stopped.

**Other hosts:** a `Dockerfile` is included. Mount a volume at `/data`, serve it over HTTPS, and set `PUBLIC_URL`.

Maps use OpenStreetMap (no API key). Address search uses the free OpenStreetMap Nominatim service. If a search doesn't find an address, tap the map to drop a pin. The Navigate button opens Google Maps directions.

## Tests
```bash
npm test
```
