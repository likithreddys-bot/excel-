# Putting Sheet Assistant in front of your team

Two things are needed: somewhere that serves the built files over **https**, and one **manifest** file that tells
Excel where they are. Everything else happens on each user's own computer.

## What leaves the computer (for your security review)

| Question | Answer |
|---|---|
| Does workbook data leave the machine? | **No.** Reading the table, working out the result and writing it all happen inside the task pane in the user's Excel. There is no server that receives data, and no analytics or telemetry. |
| What does it download? | The add-in's own files (about 60 KB gzipped) from the address in the manifest, and Microsoft's `office.js` from `appsforoffice.microsoft.com` (every Office add-in needs it). |
| What can it do to a workbook? | The manifest asks for `ReadWriteDocument`. It reads the table the user points it at (and other sheets only when the sentence names them) and adds **new sheets**. It does not change the user's own table. |
| Is there AI? | No. A fixed set of rules turns a sentence into a plan, and plain code runs it. The same sentence on the same data always gives the same result. |
| Excel version | Excel on the web, Excel for Windows or Mac (Microsoft 365, or 2019 and later) with ExcelApi 1.8. |

## 1. Host the files

Build, then put the contents of `dist/` on any static web host (an internal web server, Azure Static Web Apps,
GitHub Pages...). It must be **https**, and the folder must contain `taskpane.html`.

```bash
cd addin
npm ci
npm run build
```

### Option: GitHub Pages (from this repository)

1. In the repository: **Settings → Pages → Source: GitHub Actions**.
2. **Actions → Publish add-in → Run workflow.** It runs the tests, builds, and publishes.
   Pages serves the files publicly: anyone with the link can open `taskpane.html`. That is only the add-in's code,
   never anyone's data, but if you don't want the code public use an internal server instead.

## 2. Make the manifest

```bash
npm run manifest -- https://addins.yourcompany.example/sheet-assistant
```

This writes `dist/manifest.xml` with every address filled in (for GitHub Pages the workflow does it for you and
publishes it next to the add-in, at `.../manifest.xml`).

## 3. Install it for everyone (Microsoft 365 admin)

1. Open the **Microsoft 365 admin center → Settings → Integrated apps → Upload custom apps**.
2. Choose **Office Add-in**, then upload `manifest.xml` (or give its link).
3. Choose who gets it (everyone, or a group) and finish. It appears on each person's **Home** tab as
   **Sheet Assistant → Ask in plain English**, in every workbook, within a few hours.

To update the add-in later, host the new build at the same address. Users get the new version the next time they
open the pane; the manifest only changes if you change the address.

## Try it yourself first (no admin needed)

- **Excel on the web:** Insert → Add-ins → My Add-ins → Upload My Add-in → choose `manifest.xml`. This only lasts for
  that workbook; it's for trying things out.
- **Developers:** `npm run dev` serves it from your own computer instead (see `README.md`).
