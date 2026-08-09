# GitHub App setup

Public repositories work without any setup. A GitHub App adds two things:

- **Private repositories**: visitors sign in and can open repositories the app is installed on and
  they have access to.
- **Security alerts**: files with open code scanning or Dependabot alerts burn in the city.

CodeNavigator uses the app's *user authorisation* only: no private key, no webhooks, and tokens act
with the visitor's own permissions.

## 1. Register the app

Go to **https://github.com/settings/apps/new** (or an organisation's Developer settings) and fill in:

| Field | Value |
|---|---|
| GitHub App name | anything; it becomes the slug in `github.com/apps/<slug>` |
| Homepage URL | `https://your-host` |
| Callback URL | `https://your-host/api/github/callback` |
| Expire user authorization tokens | ✅ |
| Request user authorization (OAuth) during installation | ☐ off |
| Enable Device Flow | ☐ off |
| Setup URL | `https://your-host/`, with **Redirect on update** ✅ |
| Webhook → Active | ☐ off |
| Where can this GitHub App be installed? | **Any account** to let others use it |

**Repository permissions** (everything else "No access"):

| Permission | Access | Needed for |
|---|---|---|
| Contents | Read-only | Cloning private repositories |
| Metadata | Read-only | Added automatically |
| Code scanning alerts | Read-only | Red tape and fire |
| Dependabot alerts | Read-only | Yellow tape and fire |

Create the app, copy the **Client ID**, and click **Generate a new client secret**.

## 2. Configure the server

```bash
GITHUB_CLIENT_ID=Iv23li...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_SLUG=your-app-slug
```

Restart the server. `GET /api/github/status` should now report `"configured": true`.

## 3. Install it

Visit `https://github.com/apps/<slug>`, click **Install**, and choose the repositories it may read.
Each user (or organisation admin) installs it for their own repositories. When a signed-in visitor
opens a repository the app can't see, CodeNavigator offers a **Grant repository access** button
linking to that page.

## How sign-in behaves

- A private repo that fails to clone shows **Sign in with GitHub**. After approving on GitHub,
  visitors land back on the site with the Open codebase dialog already showing the result and the
  repository filled in.
- Tokens live only in server memory for 8 hours and are never sent to the browser. Restarting the
  server signs everyone out.
- **Adding permissions later** (e.g. alerts): existing installations must accept the new permissions
  on GitHub, and visitors need to sign out and back in to get a token with them. Until then the
  sidebar reports which alert kinds it has no access to.
