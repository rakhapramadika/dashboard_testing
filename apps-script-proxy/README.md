# Apps Script Proxy

This is the first proxy backend for the PWA. It keeps BigQuery access server-side and exposes a small JSON API.

## Deploy

1. Create a new Apps Script project.
2. Paste `Code.gs`.
3. Enable **Services > BigQuery API**.
4. Show and replace `appsscript.json`.
5. Deploy as **Web app**.
6. Use **Execute as: Me**.
7. Choose who can access the app.

## API

The PWA calls:

```text
GET /exec?action=metadata
GET /exec?action=scorecard&payload={"filters":{},"group":"channel","minUsers":50}
```

Paste the deployed `/exec` URL into the PWA sidebar as the API endpoint.
