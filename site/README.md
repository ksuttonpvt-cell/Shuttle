# Turas Lúbtha website

The public website for Turas Lúbtha (turaslubtha.com): home, features, pricing,
questions, "Book a demo", and a "Sign in — coming soon" page.

It is **separate from the shuttle app**: plain HTML and CSS, no build step, and the
app never serves this folder. Changing these pages can't affect anyone's shuttle.

| File | What it is |
|---|---|
| `index.html` | The home page (every section) |
| `signin.html` | Sign in: "coming soon" until app.turaslubtha.com exists |
| `privacy.html`, `terms.html` | Drafts, to be reviewed before launch |
| `404.html` | "Page not found" |
| `css/site.css` | All the styles (purple, teal, neon green), light and dark |
| `js/site.js` | Light/dark switch (remembered per device), sections sliding in |
| `img/shots/` | Real app screenshots (desk, driver, tracking), light and dark. Sample data only: made-up business and riders |
| `img/logo.svg`, `img/logo-dark.svg`, `img/icon.svg` | Logo #2 and the app/tab icon |

## Look at it on your computer
Open `index.html` in a browser. That's it.

## Put it online (Cloudflare Pages, free)
1. Buy **turaslubtha.com** and add it to Cloudflare.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick this repository. Settings: **Framework preset: None**, **Build command:** leave empty,
   **Build output directory:** `site`. Save and deploy.
4. In the new project: **Custom domains → Set up a domain → turaslubtha.com** (and `www`).

Every change merged to `main` republishes the website in about a minute.

## Light and dark
The site follows each visitor's device setting; the sun/moon button switches it and remembers the choice. Screenshots swap to the app's dark versions. Visitors who turn off motion on their device get no animations.

## Still to decide
- Prices (the page says "Coming soon").
- "Book a demo" opens an email to hello@turaslubtha.com; a proper form or calendar link is planned, and a walkthrough video.
- Privacy and Terms need a proper review before launch.
