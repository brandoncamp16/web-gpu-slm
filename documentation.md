# ARCNET Website Deployment Setup & Documentation

## **I. Pre-Installation: SSH & Permissions Setup**

Before moving any scripts, the machines must be able to communicate with each other (and GitLab) securely and automatically without human intervention.

### **1\. Web Dev Setup**

The Dev machine is the machine that can access GitLab. It needs to pull from GitLab and push commands to Prod.

* **Generate an SSH Key:** Run `ssh-keygen -t ed25519 -C "dev-deploy-key"` (leave the passphrase blank).  
* **GitLab Access:** Copy the public key (`cat ~/.ssh/id_ed25519_gitlab.pub`) and add it to your GitLab account's SSH Keys.  
* **SSH Config file:** Create or edit `~/.ssh/config` to handle the routing seamlessly:

**Explanation of \~/.ssh/config Values** 

Host gitlab.com \# (The host address of GitLab server.)

  HostName gitlab.com \# (The host name of the GitLab server.)

  User git \# (The User to use to access GitLab.)

  Port 2222 \# (Use the custom port of 3122\. The custom port can be seen when clicking "Clone" in GitLab.) 

  IdentityFile \~/.ssh/id\_ed25519 (Point to the ssh key made before.) 

  StrictHostKeyChecking accept-new (Allows new keys to be accepted.)

**Web Prod \~/.ssh/config**

Host thea.dc.arcnet.tech

  HostName thea.dc.arcnet.tech

  User git

  Port 3122

  IdentityFile \~/.ssh/id\_ed25519\_gitlab

  StrictHostKeyChecking accept-new

### **2\. Web Prod Setup**

The Prod machine needs to accept the Dev machine's commands.

* **Enable SSH:** If SSH isn't running, enable it with `sudo systemctl enable --now sshd`.  
* **Authorized Keys:** Copy the `id_ed25519_gitlab.pub` from your Dev machine and append it to Prod's `~/.ssh/authorized_keys` file.

### **3\. User Groups & Lingering (Both Machines)**

For the scripts to run Docker commands and execute background timers without an active user logged in, apply these to the operational user (e.g., `arcadmin` or `user`):

* **Docker Group:** Add the user to the docker group to run commands without `sudo`: `sudo usermod -aG docker $USER`  
* **Apply Group:** Log out and back in, or apply immediately with: `newgrp docker`  
* **Enable Lingering:** Allow user-level systemd services to run at boot even if you aren't logged in: `sudo loginctl enable-linger $USER`

## **II. Installation**

The scripts are divided into a polling system (Dev) and a deployment system (Prod).

### **1\. Web Dev Installation**

Create the required directories: `mkdir -p ~/deploy ~/.config/systemd/user/`

Place the files exactly as follows:

* `~/deploy/poll_and_ship.sh`  
* `~/.config/systemd/user/poll_and_ship.service`  
* `~/.config/systemd/user/poll_and_ship.timer`

**Configuration Note:** Open `~/deploy/poll_and_ship.sh` and ensure the Prod Server credentials and the target GitLab branch (e.g., `master` or `production`) are configured at the top of the file. Below are the current configuration values:

REPO="$HOME/siteCodebase"

BRANCH="production"

PROD\_HOST="10.2.20.150"

PROD\_USER="arcadmin"

SSH\_KEY="$HOME/.ssh/prod\_deploy\_ed25519"

PROD\_INCOMING="deploy/incoming"

Make the script executable and enable the timer:

* `chmod +x ~/deploy/poll_and_ship.sh`  
* `systemctl --user daemon-reload`  
* `systemctl --user enable --now poll_and_ship.timer`

### **2\. Web Prod Installation**

Create the required directories: `mkdir -p ~/deploy ~/.config/systemd/user/`

Place the files exactly as follows:

* `~/deploy/deploy.sh`  
* `~/deploy/receive_stage_build.sh`  
* `~/deploy/trigger_stage_build.sh`  
* `~/.config/systemd/user/deploy.service`  
* `~/.config/systemd/user/deploy.timer`  
* `~/.config/systemd/user/receive_stage_build.service`

Make the scripts executable and enable the midnight deploy timer:

* `chmod +x ~/deploy/*.sh`  
* `systemctl --user daemon-reload`  
* `systemctl --user enable --now deploy.timer`

## **III. Pipeline Features & Resilience**

This architecture is designed with strict health-gating and rollback capabilities. It maintains a historical list of healthy Git SHAs and uses restores to the last one in the event of failure.

By utilizing a dedicated `deployTesting` branch, this pipeline was proven resilient against 5 distinct crash scenarios during testing:

* **The Build Failure:** A broken `Dockerfile` or bad package instantly aborts the staging process. Production is never touched.  
* **The Runtime Crash:** A container builds but fatals on boot. The script detects the `exited` state and instantly rolls back.  
* **The Health Check Failure:** The container runs, but the HTTP server returns 404/500 errors. The Docker health check marks it `unhealthy`, triggering a rollback.  
* **The Slow Boot (Timeout):** The application hangs and takes longer than the 3-minute strict limit to report as healthy. The deploy is aborted and rolled back.  
* **The Crash Loop:** A container repeatedly crashes and restarts. The health check fails to stabilize, preventing a false positive and triggering the rollback.

## **IV. Operations, Testing & Logs**

Use these commands for day-to-day oversight, manual testing, and debugging.

**Triggering Pipelines Manually:**

* Run Dev poll: `systemctl --user start poll_and_ship.service`  
* Run Prod deploy: `systemctl --user start deploy.service`

**Viewing Systemd Logs:**

* Dev polling logs: `journalctl --user -u poll_and_ship.service -f`  
* Prod deploy logs: `journalctl --user -u deploy.service -f`

**Checking Timers & Scheduled Runs:**

* List all active timers: `systemctl --user list-timers --all`  
* Reload systemd after modifying `.service` or `.timer` files: `systemctl --user daemon-reload`

**Docker Insight:**

* List running containers: `docker ps`  
* List stored images: `docker images`  
* View specific container logs (requires substituting the active SHA): `RELEASE_SHA=PutSHAValueHere docker compose logs frontend` `RELEASE_SHA=PutSHAValueHere docker compose logs backend`

## **V. Uninstallation**

If you ever need to completely rip this system out of a machine, follow these steps to ensure no ghost timers are left running.

**On Web Dev:**

1. Stop and disable the timer: `systemctl --user disable --now poll_and_ship.timer`  
2. Remove the systemd files: `rm ~/.config/systemd/user/poll_and_ship.*`  
3. Remove the scripts: `rm -rf ~/deploy`  
4. Refresh systemd: `systemctl --user daemon-reload`

**On Web Prod:**

1. Stop and disable the timer: `systemctl --user disable --now deploy.timer`  
2. Remove the systemd files: `rm ~/.config/systemd/user/deploy.* ~/.config/systemd/user/receive_stage_build.service`  
3. Remove the scripts and state files: `rm -rf ~/deploy`  
4. Refresh systemd: `systemctl --user daemon-reload`