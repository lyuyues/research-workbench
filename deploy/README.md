# Deploying on a server

A sketch of the setup the project runs on. Adapt freely; the one hard rule is **authentication in front of the
app**, because the agent can read and write everything in your research folder.

1. **Server**: any small Linux box or VM. Create a user for the app, clone the repo into `~/research-workbench`,
   build it (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, `cd frontend && npm ci && npm run build`).
2. **Research folder**: put it at `~/Research` on the server and keep it in sync with your laptop (Nextcloud,
   Syncthing, git, ...). The app and the agent work on the server copy.
3. **Claude Code**: install it for the app user and run `claude setup-token`; put the token in the env file.
4. **Env file**: copy `deploy/env.example` to `~/.config/research-workbench/env`, fill it in, `chmod 600`.
5. **Service**: `deploy/research-workbench.service` is a systemd *user* unit
   (`cp deploy/research-workbench.service ~/.config/systemd/user/ && systemctl --user enable --now research-workbench`,
   plus `loginctl enable-linger $USER` so it runs without a login session). It listens on 127.0.0.1:8000 only.
6. **Access**: publish it with a Cloudflare Tunnel (`cloudflared tunnel ... --url http://127.0.0.1:8000`) and protect
   the hostname with a Cloudflare Access application that allows only your e-mail. Put the team name and the
   application's AUD tag in the env file; with `RP_REQUIRE_ACCESS=1` the app refuses requests without a valid token.
7. **Scheduled jobs** (optional): `jobs/scheduler.py` runs the jobs listed in its `JOBS` table; call it every minute
   from cron (`* * * * * cd ~/research-workbench && .venv/bin/python -m jobs.scheduler`).
