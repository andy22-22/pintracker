# PinScout — Setup Guide

## What you need
- Your GitHub account: andy22-22
- 5 minutes

---

## Step 1: Create a GitHub Repository

1. Go to **github.com** and sign in
2. Click the **+** icon (top right) → **New repository**
3. Name it exactly: `pintracker`
4. Make sure it is set to **Public**
5. Check the box: **"Add a README file"**
6. Click **Create repository**

---

## Step 2: Upload the App Files

1. Inside your new `pintracker` repo, click **Add file** → **Upload files**
2. Drag and drop ALL THREE files from this folder:
   - `index.html`
   - `manifest.json`
   - `icon.png`
3. Scroll down, click **Commit changes**

---

## Step 3: Enable GitHub Pages

1. In your repo, click **Settings** (top tab)
2. Scroll down to **Pages** in the left sidebar
3. Under "Branch", select **main** and **/ (root)**
4. Click **Save**
5. Wait ~60 seconds, then your app will be live at:

   **https://andy22-22.github.io/pintracker/**

---

## Step 4: Add to iPhone Home Screen

1. Open Safari on your iPhone
2. Go to: `https://andy22-22.github.io/pintracker/`
3. Tap the **Share** button (box with arrow at bottom of Safari)
4. Scroll down and tap **"Add to Home Screen"**
5. Name it "PinScout" and tap **Add**

It will now appear as an app icon on your home screen!

---

## Step 5: Add your eBay API Key (when it arrives)

Once your eBay Developer account is approved:

1. Go to **developer.ebay.com** → My Account → Application Keys
2. Copy your **App ID (Client ID)** for the Production environment
3. Open PinScout → tap **Settings** tab
4. Paste your App ID and tap **Save Settings**

This unlocks automatic price fetching directly in the app.

**Until then:** The app will show direct links to eBay search results for any pin you search — you can view sold prices manually on eBay while you wait.

---

## How to Use

### Text Search
1. Type a pin name (e.g. "Haunted Mansion stretching room 2023")
2. Tap **Search eBay Prices**
3. See estimated value, sold history, and active listings

### Image Search
1. Tap the 📷 camera icon
2. Choose **Take Photo** or **Choose from Library**
3. Optionally open **Google Lens** to identify the pin name first
4. Edit the search term if needed, then tap Search

### History
- Every search is automatically saved
- Tap any history entry to re-run that search
- Tap 🗑 to delete individual entries

---

## Your App URL
https://andy22-22.github.io/pintracker/
