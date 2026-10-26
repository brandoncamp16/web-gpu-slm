# Docker Website Deployment Setup & Documentation

---

## **I. Manual Process: Running the Site From Scratch**

Before setting up any automated pipelines, you can build, configure, and run your multi-container application stack entirely manually on your host machine.

### **1. Installing Docker & Docker Compose**

- **Install Docker Engine:** Follow your Linux distribution's official guide, then ensure the daemon is active and enabled:
  ```bash
  sudo systemctl enable --now docker
  ```

- **Verify Docker Compose:** Ensure the Docker Compose CLI plugin is installed (either via your system package manager or as a user plugin in `~/.docker/cli-plugins/docker-compose`). Verify the installation with:
  ```bash
  docker compose version
  ```

### **2. Cloning and Preparing the Codebase**

- **Clone Repository:** Clone your project repository into your desired target runtime directory:
  ```bash
  git clone <your-repo-url> ~/siteCodebase
  cd ~/siteCodebase
  ```

- **Configure Environment Variables:** Create and configure your environment variables file (`.env`) in the root directory with all required secrets, database credentials, and port configurations.

  - **Example Development `.env` Structure:**
    ```env
    # Make Docker use the dev file for development mode
    COMPOSE_PATH_SEPARATOR=:
    COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
    API_URL=http://backend:1616
    MONGODB_URI=mongodb://MongoAdmin:Test1234!@mongodb:27017/docker-website?authSource=admin
    JWT_SECRET=super_secret_local_key_123
    ADMIN_DEFAULT_PASSWORD=Test1234!
    NODE_ENV=development
    CORS_ORIGIN=http://localhost
    SMTP_HOST=mailhog
    SMTP_PORT=1025
    SMTP_USER=
    SMTP_PASS=
    EMAIL_FROM=Example Email <example@email.com>
    CONTACT_TO=example@email.com
    ```

  - **Example Production `.env` Structure:**
    ```env
    # Make Docker use the prod file for production mode
    COMPOSE_PATH_SEPARATOR=:
    COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
    API_URL=http://backend:1616
    MONGODB_URI=mongodb://MongoAdmin:Test1234!@mongodb:27017/docker-website?authSource=admin
    JWT_SECRET=super_secret_local_key_123
    ADMIN_DEFAULT_PASSWORD=Test1234!
    NODE_ENV=production
    CORS_ORIGIN=https://example.com
    SMTP_HOST=smtp.example.com
    SMTP_PORT=
    SMTP_USER=
    SMTP_PASS=
    EMAIL_FROM=Example Email <example@email.com>
    CONTACT_TO=example@email.com
    ```

### **3. Environment Switching via `COMPOSE_FILE`**

Docker Compose dynamically merges configuration files based on the `COMPOSE_FILE` variable specified in your `.env` file:
- **Development Mode:** Merges `docker-compose.yml` with `docker-compose.dev.yml` using `COMPOSE_PATH_SEPARATOR=:`.
- **Production Mode:** Merges `docker-compose.yml` with `docker-compose.prod.yml`.

### **4. Production SSL Setup (`.pem`, Docker Compose, & Nginx)**

For production environments running on HTTPS, proper configuration of the SSL certificate and Nginx server blocks is required:

- **`docker-compose-prod.yml` Volume Mapping:**
  Ensure your production override file maps your root `example.pem` certificate into the container securely:
  ```yaml
  services:
    frontend:
      ports:
        - "80:80"
        - "443:443"
      volumes:
        - ./frontend/nginx/nginx.prod.conf:/etc/nginx/conf.d/default.conf:ro
        - ./example.pem:/etc/nginx/ssl/example.pem:ro
      healthcheck:
        test: ["CMD-SHELL", "curl -fsSk https://localhost/ >/dev/null || exit 1"]
        interval: 10s
        timeout: 5s
        retries: 3
  ```
  *(Note: `example.pem` must be a combined PEM file containing both your public certificate and private key if using it for both `ssl_certificate` and `ssl_certificate_key`).*

- **`nginx.prod.conf` Configuration:**
  ```nginx
  server {
      listen 80;
      server_name example.com www.example.com;

      return 301 https://$host$request_uri;
  }

  server {
      listen 443 ssl;
      server_name example.com www.example.com;

      ssl_certificate /etc/nginx/ssl/example.pem;
      ssl_certificate_key /etc/nginx/ssl/example.pem;

      add_header Strict-Transport-Security "max-age=3153600; includeSubDomains; preload" always;

      root /usr/share/nginx/html;
      index index.html;

      # Frontend Static Files
      location / {
          try_files $uri $uri/ /index.html;
      }

      # Proxy API Requests to Backend
      location /api/ {
          proxy_pass http://backend:1616;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection 'upgrade';
          proxy_set_header Host $host;
          proxy_cache_bypass $http_upgrade;
      }
  }
  ```

### **5. Building Docker Images via Docker Compose**

Because application services (such as the frontend depending on the backend and database) require orchestration context, build the entire multi-container stack together using Docker Compose:
```bash
docker compose build
```

### **6. Running Containers (Normal vs. Detached Modes)**

- **Foreground (Normal) Mode:** Runs containers attached directly to your current terminal session. This allows you to inspect real-time log outputs on screen. Press `Ctrl+C` to terminate the containers:
  ```bash
  docker compose up
  ```

- **Detached Mode:** Runs containers safely in the background as background daemons, freeing up your terminal for other commands:
  ```bash
  docker compose up -d
  ```

---

## **II. Automated Pipeline Setup Architectures**

Choose **one** of the two deployment architectures below depending on your infrastructure and security needs:

1. **Single-Machine Setup:** Both the polling script and the deployment scripts reside and run on the same hosting machine. It monitors local Git changes and triggers deployments via a local loopback SSH connection (`127.0.0.1`).
2. **Split 2-Machine Setup (Dev & Prod):** A high-security configuration where a Dev machine pulls from Git repositories and pushes compiled release payloads securely via SSH to a hardened Prod web-hosting machine that has no direct internet or Git repository access.

---

## **III. Method 1: Full Automated Pipeline Installation (Single-Machine Setup)**

If you are running everything on a single server or Steam Deck, follow this self-contained installation guide.

### **1. System Privileges, Lingering, & Docker Group Verification**

- **Docker Group Setup:** Add your user to the `docker` group to run container commands without `sudo`:
  ```bash
  sudo usermod -aG docker $USER
  newgrp docker
  ```

- **Testing Docker Group Permissions:** Open a completely **new terminal window** and test the permissions by running:
  ```bash
  docker ps
  ```
  If it successfully outputs a container table rather than a "permission denied" error, your user session is correctly authenticated. If it fails, a **system reboot / machine restart** is required to fully apply group changes across all system sessions.

- **Enable Lingering:** Ensure user-level systemd daemons persist at boot even when no interactive shell session is logged in:
  ```bash
  sudo loginctl enable-linger $USER
  sudo systemctl restart user@$(id -u).service
  ```

### **2. Directory Creation & Permissions**

Create all necessary state, build, release, and runner directories on this single machine:
```bash
mkdir -p ~/deploy/state ~/deploy/releases ~/deploy/incoming ~/deploy/build ~/siteCodebase ~/.config/systemd/user
chmod 700 ~/deploy/state ~/deploy/releases ~/deploy/incoming ~/deploy/build
chmod 755 ~/siteCodebase
```

### **3. Local Loopback SSH Key Setup**

Because the single-machine pipeline triggers deployments via SSH to `127.0.0.1`:

- **Generate Keypair:** Create an Ed25519 keypair:
  ```bash
  ssh-keygen -t ed25519 -C "single-machine-deploy"
  ```
  (Leave the passphrase completely blank by pressing Enter twice).

- **Secure Permissions & Authorize Key:**
  ```bash
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/id_ed25519
  chmod 644 ~/.ssh/id_ed25519.pub
  cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  ```

- **Configure Non-Interactive Verification:** Add the following block to `~/.ssh/config` to prevent hanging:
  ```text
  Host 127.0.0.1 localhost
      IdentityFile ~/.ssh/id_ed25519
      StrictHostKeyChecking accept-new
      UserKnownHostsFile ~/.ssh/known_hosts
  ```

- **Clean Up Stale Keys:**
  ```bash
  ssh-keygen -R 127.0.0.1
  ssh-keygen -R localhost
  ```

- **Git Access:** Add your public key (`cat ~/.ssh/id_ed25519.pub`) to your GitHub/GitLab account for repository access.

### **4. File Placement & Service Activation**

- **Place Scripts:** Put your automation scripts in `~/deploy/`:
  - `poll_and_ship.sh` (configured to point `PROD_HOST="127.0.0.1"`).
  - `deploy.sh`
  - `receive_stage_build.sh`
  - `trigger_stage_build.sh`

- **Place Systemd Unit Files:** Put your unit files in `~/.config/systemd/user/`:
  - `poll_and_ship.service` & `poll_and_ship.timer`
  - `deploy.service` & `deploy.timer`
  - `receive_stage_build.service`

- **Make Scripts Executable & Enable Timers:**
  ```bash
  chmod +x ~/deploy/*.sh
  systemctl --user daemon-reload
  systemctl --user enable --now poll_and_ship.timer
  systemctl --user enable --now deploy.timer
  ```

---

## **IV. Method 2: Full Automated Pipeline Installation (Split 2-Machine Setup)**

If you are using a separate Dev machine (for Git polling) and a Prod machine (for hosting), follow these distinct steps for each machine to prevent unnecessary folders.

---

### **Part A: Dev Machine Installation (Polling & Shipping)**

#### **1. Dev Directory Creation & Permissions**

Provision *only* the directories required for polling on the Dev machine:
```bash
mkdir -p ~/deploy/state ~/siteCodebase ~/.config/systemd/user
chmod 700 ~/deploy/state
chmod 755 ~/siteCodebase
```

#### **2. Dev SSH Key Setup & Git Access**

- **Generate Keypair:** Create an Ed25519 keypair:
  ```bash
  ssh-keygen -t ed25519 -C "dev-deploy-key"
  ```
  (Leave the passphrase blank).

- **Secure Permissions:**
  ```bash
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/id_ed25519
  chmod 644 ~/.ssh/id_ed25519.pub
  ```

- **Configure SSH Config:** Add your Prod host details to `~/.ssh/config` for non-interactive connection parameters:
  ```text
  Host prod-server-ip-or-alias
      IdentityFile ~/.ssh/id_ed25519
      StrictHostKeyChecking accept-new
      UserKnownHostsFile ~/.ssh/known_hosts
  ```

- **Clear Stale Entries:**
  ```bash
  ssh-keygen -R prod-server-ip-or-alias
  ```

- **Distribute Key:** Copy your public key (`cat ~/.ssh/id_ed25519.pub`) and add it to your GitHub/GitLab account **and** append it to the Prod machine's `~/.ssh/authorized_keys` file.

#### **3. Dev Script & Timer Activation**

- **Place Files:**
  - Script in `~/deploy/`: `poll_and_ship.sh` (configured with your remote Prod IP/hostname and user).
  - Systemd Units in `~/.config/systemd/user/`: `poll_and_ship.service` and `poll_and_ship.timer`.

- **Enable on Dev:**
  ```bash
  chmod +x ~/deploy/poll_and_ship.sh
  systemctl --user daemon-reload
  systemctl --user enable --now poll_and_ship.timer
  ```

---

### **Part B: Prod Machine Installation (Hosting & Deployment)**

#### **1. Prod System Privileges, Lingering, & Docker Group Verification**

- **Docker Group Setup:** Add your user to the docker group:
  ```bash
  sudo usermod -aG docker $USER
  newgrp docker
  ```

- **Testing Docker Group Permissions:** Open a new terminal window on Prod and test permissions:
  ```bash
  docker ps
  ```
  If permission is denied, perform a **system reboot / machine restart** to cleanly refresh group assignments.

- **Enable Lingering:** Ensure background user services run persistently:
  ```bash
  sudo loginctl enable-linger $USER
  sudo systemctl restart user@$(id -u).service
  ```

#### **2. Prod Directory Creation & Permissions**

Provision *only* the directories required for receiving builds and running production containers:
```bash
mkdir -p ~/deploy/state ~/deploy/releases ~/deploy/incoming ~/deploy/build ~/siteCodebase ~/.config/systemd/user
chmod 700 ~/deploy/state ~/deploy/releases ~/deploy/incoming ~/deploy/build
chmod 755 ~/siteCodebase
```

#### **3. Prod Authorized Keys Setup**

Ensure the Dev machine's public key is appended to `~/.ssh/authorized_keys` on Prod:
```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
# Paste or append Dev's id_ed25519.pub contents into ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

#### **4. Prod Script & Timer Activation**

- **Place Files:**
  - Scripts in `~/deploy/`: `deploy.sh`, `receive_stage_build.sh`, `trigger_stage_build.sh`.
  - Systemd Units in `~/.config/systemd/user/`: `deploy.service`, `deploy.timer`, `receive_stage_build.service`.

- **Enable on Prod:**
  ```bash
  chmod +x ~/deploy/*.sh
  systemctl --user daemon-reload
  systemctl --user enable --now deploy.timer
  ```

---

## **V. Pipeline Features, Resilience, Operations & Troubleshooting**

### **1. Built-in Resilience & Crash Protection**

The pipeline maintains a strict audit trail of healthy Git SHAs and automatically rolls back when anomalies are detected:

- **The Build Failure:** Syntax errors in `Dockerfile` abort staging immediately; production remains untouched.
- **The Runtime Crash:** Containers boot but exit unexpectedly; the script triggers an immediate fallback rollback.
- **The Health Check Failure:** HTTP health endpoints fail, marking containers `unhealthy` and initiating a rollback.
- **The Slow Boot Timeout:** If startup exceeds strict time limits, deployment aborts safely.
- **The Crash Loop:** Continuous restart loops are intercepted before reaching production users.

### **2. Day-to-Day Operations & Management**

- **Trigger Pipelines Manually:**
  - Run poll & ship (Dev / Single): `systemctl --user start poll_and_ship.service`
  - Run deploy (Prod / Single): `systemctl --user start deploy.service`

- **Inspect Systemd Logs:**
  - Polling logs: `journalctl --user -u poll_and_ship.service -f`
  - Deploy logs: `journalctl --user -u deploy.service -f`

- **Container Diagnostics:**
  - List running containers: `docker ps`
  - View specific container logs: `RELEASE_SHA=<sha> docker compose logs frontend`

### **3. Complete Uninstallation**

- **On Polling / Dev Machine:**
  ```bash
  systemctl --user disable --now poll_and_ship.timer
  rm ~/.config/systemd/user/poll_and_ship.*
  rm -rf ~/deploy
  systemctl --user daemon-reload
  ```

- **On Deployment / Prod Machine:**
  ```bash
  systemctl --user disable --now deploy.timer
  rm ~/.config/systemd/user/deploy.* ~/.config/systemd/user/receive_stage_build.service
  rm -rf ~/deploy
  systemctl --user daemon-reload
  ```