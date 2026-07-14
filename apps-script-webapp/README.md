# Apps Script secure web app

Use this folder when the dashboard must be restricted to Allofresh Google Workspace users.

## Files to upload

- `Code.gs`
- `Index.html`
- `Client.html`
- `Styles.html`
- `appsscript.json`

## Apps Script setup

1. Create or open an Apps Script project.
2. Enable **Project Settings > Show appsscript.json manifest file in editor**.
3. Replace the manifest with `appsscript.json`.
4. Add the BigQuery advanced service from **Services > + > BigQuery API**.
5. Create the HTML files using the exact names above.
6. Paste each file from this folder.

## Deploy

Deploy as a web app:

- **Execute as**: `Me`
- **Who has access**: `Anyone within allofresh.id`

This keeps BigQuery access server-side and lets Google Workspace handle the login gate.

## Cache behavior

Summary queries are cached per filter/group combination. Cache rolls over daily after 09:00 WIB.

For manual refresh before 09:00, run `clearDashboardCache()` once from the Apps Script editor, then redeploy or reload the web app.
