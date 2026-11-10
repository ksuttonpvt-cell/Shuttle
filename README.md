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

### Putting it online
Any host that runs Node 22 and keeps a disk works, for example a small VPS, Render, Railway, or Fly.io with a volume. Run it behind HTTPS (drivers' phones only share GPS over HTTPS), set `PUBLIC_URL` so the QR codes point to the real address, and keep `DB_FILE` on persistent storage.

Maps use OpenStreetMap (no API key). Address search uses the free OpenStreetMap Nominatim service. If a search doesn't find an address, tap the map to drop a pin. The Navigate button opens Google Maps directions.

## Tests
```bash
npm test
```
