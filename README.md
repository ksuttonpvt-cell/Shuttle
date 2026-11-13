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

**Forgot password?** On the sign-in screen, tap *Forgot your password?* and enter your email. Every admin sees a 🔑 banner in the admin page (and gets a phone notification if they turned notifications on). The admin taps **Send reset link**, then texts, emails, or shows the QR code to the person. The link works once, expires in 24 hours, and signs that person out of every old device. Admins can also make a link anytime from *Staff & logins → Send reset link*.

### Driver lock-screen notifications
Drivers can get new rides on their phone's lock screen, even when the shuttle app is closed. There's nothing to sign up for: the server makes its own notification keys the first time it starts.
- **Android (Chrome):** open the site, sign in, go to the **Phone notifications** card, tap **Turn on notifications**, then **Allow**. **Install the Shuttle app** adds an icon to the home screen.
- **iPhone (iOS 16.4 or newer):** in Safari tap **Share → Add to Home Screen**, open **Shuttle** from the home screen and sign in there, then tap **Turn on notifications**. Apple only allows notifications for sites added to the Home Screen.
- **What they get:** a new ride (sent to drivers who are on duty), a ride assigned to them, and their ride being cancelled by someone else. **Send a test** checks it's working.
- The site must be on **https** (the Cloudflare address), and the server needs normal internet access to reach Google's and Apple's notification services.

### Customer texts (optional)
The site can text customers automatically when their ride is booked, when the driver is on the way, and if the ride is cancelled. It uses **Twilio** (about 1¢ per text):
1. Create an account at twilio.com and buy a phone number. US numbers also need the free "A2P 10DLC" business registration.
2. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` to `.env`, then restart the site.
3. In **Admin → Settings → Customer texts**, choose which messages to send, and use **Send test** to check it works. Recent texts and any failures are listed there.

Without these settings no texts are sent, and the advisor's **Text** button still opens their own phone's messaging app.

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

**Updates install themselves.** While the site is running, it checks GitHub every 5 minutes. When changes have been merged into `main`, it downloads them and restarts itself in a couple of seconds. Open pages carry on by themselves, and nobody has to restart anything. If the site ever crashes, it restarts after 10 seconds. **Admin → Settings → Software updates** shows the running version and when it last checked, and has a **Check for updates now** button.
- This works when the app is started with `start-shuttle.bat` or `npm start`.
- If Settings shows an update problem mentioning sign-in or authentication, open PowerShell in the app folder and run `git pull` once. Git will ask you to sign in to GitHub and remember it.
- To turn automatic updates off, add `AUTO_UPDATE=0` to `.env`. To change how often it checks, set `UPDATE_CHECK_MINUTES`.

**Backups:** everything (rides, logins, vehicles) is stored in `C:\Shuttle\data`. Copy that folder somewhere safe regularly, such as a USB drive or OneDrive. The most reliable copy is one made while the task is stopped.

**Other hosts:** a `Dockerfile` is included. Mount a volume at `/data`, serve it over HTTPS, and set `PUBLIC_URL`.

Maps use OpenStreetMap (no API key). Address search uses the free OpenStreetMap Nominatim service. If a search doesn't find an address, tap the map to drop a pin. The Navigate button opens Google Maps directions.

## Tests
```bash
npm test
```
