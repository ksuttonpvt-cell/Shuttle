# Turas Lúbtha website

The public website for Turas Lúbtha (turaslubtha.com): home, features, pricing,
questions, "Book a demo", and a "Sign in — coming soon" page.

It is **separate from the shuttle app**: plain HTML and CSS, no build step, and the
app never serves this folder. Changing these pages can't affect anyone's shuttle.

| File | What it is |
|---|---|
| `index.html` | The home page (every section) |
| `signin.html` | The shared sign-in (also served at app.turaslubtha.com): email + password → your own business |
| `privacy.html`, `terms.html` | Drafts, to be reviewed before launch |
| `404.html` | "Page not found" |
| `css/site.css` | All the styles (purple, teal, neon green), light and dark |
| `js/site.js` | Light/dark switch (remembered per device), sections sliding in |
| `img/shots/` | Real app screenshots (desk, driver, tracking), light and dark. Sample data only: made-up business and riders |
| `img/logo.svg`, `img/logo-dark.svg`, `img/icon.svg` | Logo #2 and the app/tab icon |

## Look at it on your computer
On the shuttle PC, with the shuttle running: open **http://website.localhost:3000**.
Or from anywhere: **your shuttle address + `/website/`** (for example https://corwinshuttleservice.com/website/).
(Or just open `index.html` in a browser.)

## Put it online, on your own PC
The shuttle program on your PC serves this website too, whenever it's visited by its own
name. Visits by that name only ever get these pages, never the shuttle app.
1. Buy **turaslubtha.com** and add it to Cloudflare (the same account as your shuttle tunnel).
2. Cloudflare dashboard: **Zero Trust → Networks → Tunnels** → your shuttle's tunnel →
   **Public hostnames → Add a public hostname**: subdomain empty, domain **turaslubtha.com**,
   service **HTTP**, URL **localhost:3000**. Add another for **www**.
3. Open https://turaslubtha.com. Every change merged to `main` reaches the PC with the
   usual automatic update.

Using a different name? Put `WEBSITE_HOSTS=yourname.com` in the shuttle's `.env` file.

## Light and dark
The site follows each visitor's device setting; the sun/moon button switches it and remembers the choice. Screenshots swap to the app's dark versions. Visitors who turn off motion on their device get no animations.

## Still to decide
- Prices (the page says "Coming soon").
- "Book a demo" opens an email to hello@turaslubtha.com; a proper form or calendar link is planned, and a walkthrough video.
- Privacy and Terms need a proper review before launch.
