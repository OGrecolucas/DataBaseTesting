# Connecting to the Hermes database

Hermes is the service behind Workflows. Its data is in a Postgres database.

Each acceptance environment (qa00 to qa22) has its own Hermes database. They are all in the Google Cloud project **`qa-econo-cm`**. There is no Hermes database in staging (`stage-econo-cm`) any more, so older docs that point there are out of date.

## What you need

- Your **CPA account** (`a#####_cpa@visma.com`). Your normal Visma account can't see the databases.
- Slack, to get the password from Spook.
- The Google Cloud CLI (`gcloud`) and the Cloud SQL Proxy.
- A Postgres client, for example the **PostgreSQL** extension for VS Code, or DBeaver.

---

## Step 1: Request access in the MIM portal

In the [MIM portal](https://mimportal.visma.com/identitymanagement/default.aspx), request these groups for your **CPA account**:

| Group | What it's for |
|---|---|
| `GCP-416384539595-DeveloperReader` | Basic read access to the acceptance project. The other two need it. |
| `GCP-416384539595-DeveloperPrivileged` | Developer access to the acceptance project |
| `GCP-416384539595-CloudSQLAdmin` | Access to the Cloud SQL databases |

`416384539595` is the acceptance project (`qa-econo-cm`). Groups starting with `GCP-85778090229-` are for staging and won't help here.

Wait until all three are approved. The access is time-limited, so it may need to be activated or renewed later.

## Step 2: Install the tools (one time)

1. Install the Cloud SQL Proxy(Google Cloud CLI is included in dev-scripts):
   ```
   gcloud components install cloud-sql-proxy
   ```
   If that doesn't work, download it from the [Cloud SQL Proxy page](https://cloud.google.com/sql/docs/postgres/sql-proxy#install).
2. Install a Postgres client (the VS Code PostgreSQL extension or DBeaver).

## Step 3: Log in to gcloud with your CPA account

```
gcloud auth login
```

A browser window opens. Sign in with your **CPA account**. Then make it the active account:

```
gcloud config set account a#####_cpa@visma.com
```

Check that you can see the Hermes databases:

```
gcloud sql instances list --project=qa-econo-cm --filter="name~hermes"
```

You should see `hermes-qa00` to `hermes-qa22`. If you get "not authorized", your MIM access isn't active yet, or gcloud is using the wrong account (check with `gcloud auth list`).

## Step 4: Get the password from Spook

1. In Slack, type `/spook`.
2. Choose:
   - **Environment type:** `acceptance`
   - **Environment name:** the environment you want, for example `qa15`
   - **Secret:** `hermes/postgres_hermes_bi`
3. Click **Request**. Spook sends you a one-time link in Slack.
4. Open the link while logged in to Google with your **normal** account (`first.last@visma.com`), not the CPA one. The link only works once.

The secret has the username (`hermes_bi`) and the password. **Each environment has its own password**, so request the secret for the environment you will connect to.

## Step 5: Start the Cloud SQL Proxy

The proxy opens a secure tunnel from your computer to the database. Run it in a terminal and **leave that window open** while you work:

```
cloud-sql-proxy qa-econo-cm:europe-north2:hermes-qa15 --port 5432 --gcloud-auth
```

- Change `qa15` to your environment (it must match the Spook secret).
- If it says port 5432 is already in use, use `--port 5433` instead.
- `--gcloud-auth` makes the proxy use the account you logged in with in step 3.

When it says it's ready for new connections, go to the next step.

## Step 6: Connect with your Postgres client

Create a new connection with these settings:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `5432` (or the port you chose in step 5) |
| Database | `hermes` |
| Username | `hermes_bi` |
| Password | the one from Spook |
| SSL | disabled (the proxy already encrypts the connection) |

You should be able to test connection and see the tables for the database.


---

## Without the proxy: Cloud SQL Studio

For quick queries you can use the browser instead of steps 2, 5 and 6:

1. Open the [Cloud SQL instances in qa-econo-cm](https://console.cloud.google.com/sql/instances?project=qa-econo-cm), logged in with your CPA account.
2. Click your instance (for example `hermes-qa15`).
3. In the left menu, click **Cloud SQL Studio**.
4. Log in with database `hermes`, user `hermes_bi` and the password from Spook.

## Good to know

- **Two databases:** `hermes` has the workflows and the documents and bank lines they ran on. `hermes_engine` only holds the workflow engine's internal data, so you'll rarely need it.
- **Main tables in `hermes`:** `Workflows`, `WorkflowEntityDatas` (which document or bank line a workflow ran on), `WorkflowExecutionHistories` (what happened in each run), `GlobalWorkflows` and `GlobalWorkflowAssignments` (accounting office workflows shared with clients).
- **Use double quotes** around table and column names, because they have capital letters:
  ```sql
  SELECT * FROM "Workflows" LIMIT 10;
  ```
- **Only read.** Stick to `SELECT` queries. This is a shared environment that other teams use.

## Common problems

| Problem | What to do |
|---|---|
| `not authorized` in gcloud | Check that your MIM groups are approved and active, and that gcloud uses your CPA account (`gcloud auth list`). |
| `instance does not exist` | You're probably looking in the staging project. Use `--project=qa-econo-cm`. |
| `password authentication failed` | The Spook secret is for a different environment than the instance you connected to. |
| `address already in use` | Another program uses port 5432. Start the proxy with `--port 5433` and use 5433 in your client. |
| The Spook link gives an error | Open it while logged in to Google with your normal `first.last@visma.com` account, not the CPA one. |
