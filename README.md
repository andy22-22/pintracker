# PinScout — Setup Guide

## What you need
- GitHub account: andy22-22 ✅
- Free Cloudflare account (new — 2 minutes to create)
- Your eBay App ID: AndrewWe-pintrack-PRD-28f6186d5-8fb89236 ✅

---

## Step 1: Upload the updated files to GitHub

1. Go to github.com/andy22-22 → your pintracker repo
2. Click Add file → Upload files
3. Upload BOTH: index.html and cloudflare-worker.js
   (GitHub replaces the old index.html automatically)
4. Click Commit changes

---

## Step 2: Set up your free Cloudflare Worker

WHY: eBay's API blocks direct browser requests (a browser security rule called CORS).
The Worker runs in Cloudflare's cloud, calls eBay on your behalf, and returns the data.
Free tier is more than enough. No credit card needed.

2a. Go to cloudflare.com → sign up free

2b. In the dashboard: Workers & Pages → Create → Create Worker
    Name it: pinscout
    Click Deploy

2c. Click Edit code
    Select all the placeholder code → delete it
    Copy everything from cloudflare-worker.js → paste it in
    Click Deploy

2d. Your Worker URL will look like:
    https://pinscout.YOURNAME.workers.dev
    Copy this URL — you need it in Step 3.

---

## Step 3: Enter your credentials in PinScout

1. Open https://andy22-22.github.io/pintracker/
2. Tap Settings (⚙️)
3. Cloudflare Proxy URL → paste your Worker URL from Step 2d
4. eBay App ID → AndrewWe-pintrack-PRD-28f6186d5-8fb89236
5. Tap Save Settings

You should see: ✅ Connected — live eBay data enabled

Now search any pin and you'll get real prices instantly!

---

## Step 4: Add to iPhone Home Screen

Open the app URL in Safari → Share button → Add to Home Screen → Add

---

## What the results show

- Median estimated value (based on recent sold prices)
- Average sold price + average listed price
- Price distribution chart
- Up to 10 recent sold listings with dates (tap any to open on eBay)
- Up to 8 current active listings
- HIGH/LOW tags on outlier prices

---

## App URL
https://andy22-22.github.io/pintracker/
