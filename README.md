# Forge — CodeCraft Playground

Forge is a browser-only coding playground for the OpenAI-compatible [CodeCraft API](https://codecraftapi.com/docs). It can chat with models on your CodeCraft account, inspect a local project, stage approved edits, and push a batch of changes to a GitHub branch.

## Important: usage and cost

Forge has **no application-level usage counter or cap**. That does **not** make model access universally free or unlimited: CodeCraft account allowances, rate limits, model pricing, and upstream availability still apply. Check the current terms and usage in your CodeCraft dashboard before using a model. This project does not provide or subsidize API credits.

## Run locally

This is a dependency-free static site. Serve the repository root over HTTP:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. A secure context (HTTPS, or localhost) is required for the browser's native writable folder picker. No API keys are bundled in the site.

## Connect CodeCraft

1. Create a key in your [CodeCraft dashboard](https://codecraftapi.com/dashboard) with the scopes needed for inference and model listing.
2. In Forge, choose **Connect API** and paste the key.
3. Forge fetches `GET https://codecraftapi.com/v1/models`, then sends chat requests to `POST https://codecraftapi.com/v1/chat/completions`.

The key is held in JavaScript memory for the current tab only; it is not written to local storage, a cookie, or a Forge server. Refreshing or closing the tab clears it. Requests go directly from the browser to CodeCraft. A provider-side CORS policy or account limit can prevent browser requests; Forge does not proxy or bypass those controls.

## Agent workspaces

### Local folder

On browsers with the File System Access API (typically Chromium-based browsers on HTTPS or localhost), **Local folder** grants read/write access to the folder you choose. Forge reads supported text files into tab memory and asks you to approve each file write before saving it. The agent does not have shell or terminal access and cannot run commands or tests.

On browsers without a writable folder picker, Forge imports a selected folder read-only. Approved edits stay in tab memory and can be downloaded as a ZIP while the page is open.

### GitHub repository

- Public repositories can be loaded without a GitHub token; private repositories require a token with read access.
- To push staged agent edits, provide a fine-grained GitHub personal access token scoped to the target repository with **Contents: read and write**. Add **Workflows: read and write** only if you intentionally edit files under `.github/workflows/`. Prefer the narrowest repository scope available.
- The token stays in tab memory. Forge creates a Git commit on the selected branch using the GitHub REST API; review the staged file changes before pushing.

Forge loads a bounded set of text files (up to 140 files / about 720,000 characters; individual files are limited to 180 KB). Dependency, build, and binary directories are skipped. The workspace file contents and tokens are not persisted by Forge, but the connected providers receive the requests and data needed to provide their services.

## Deploy to GitHub Pages

The workflow at `.github/workflows/pages.yml` publishes the static app when changes reach `main` and on manual workflow dispatch.

1. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the build and deployment source.
2. Merge the app into `main`, or run **Actions → Deploy Forge to GitHub Pages → Run workflow** on `main`.
3. GitHub Pages will publish it at the repository's `https://<owner>.github.io/<repository>/` URL (or the configured custom domain).

The static app itself needs no server-side secrets. The deployed app still requires each user to bring their own CodeCraft key; users who push to GitHub also bring their own GitHub token.

## Browser and security notes

- Do not paste credentials into the chat. Use the dedicated connection forms, and avoid shared or untrusted devices.
- API calls are made directly to CodeCraft and GitHub from the browser. Use provider documentation and account settings to understand data handling, billing, and access scopes.
- Review every proposed local write and every staged GitHub change. Forge intentionally does not execute repository code or shell commands.
- GitHub Pages is a public static host. Never place a real API key, access token, or private source code in the published files.
