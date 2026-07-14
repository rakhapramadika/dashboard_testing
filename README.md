# Dashboard Testing

Installable PWA shell for AI-generated BigQuery dashboards.

## Local Preview

Because this app uses a service worker, preview it with a local server:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Deployment

This repo can be served directly by GitHub Pages:

1. Push the repo to GitHub.
2. Open repository settings.
3. Go to **Pages**.
4. Set source to `Deploy from a branch`.
5. Select `main` and `/root`.
6. Open the GitHub Pages URL.

## API Contract

Set the API endpoint in the sidebar. The frontend calls:

```text
GET {endpoint}?action=metadata
GET {endpoint}?action=scorecard&payload={...json...}
```

The endpoint should return JSON arrays/objects from a backend such as Apps Script or Cloud Run.

Current Apps Script proxy:

```text
https://script.google.com/a/macros/allofresh.id/s/AKfycbw6aaSke78nstNJdeJ1sGOrvBxlUiKxh03EIlMIPsFnJBpywKw5fZEYrzEa0_jxy4k1/exec
```
