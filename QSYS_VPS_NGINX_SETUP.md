# QSYS VPS Nginx Setup

This setup keeps the main website on `/` and forwards only `/qsys` to the QSYS app.

## Current live status

- production base URL: `https://onegourmetph.com/qsys`
- HTTP redirects to HTTPS
- TLS is terminated by Docker Nginx in `og_nginx`
- QSYS upstream container is `og-qsys-app` on port `3100`
- cert renewal is handled by root cron plus a sync script

## Assumed VPS layout

- app repo checkout: `/opt/og-qsys/app`
- runtime folder: `/opt/og-qsys`
- Nginx container name: `og_nginx`
- QSYS container name: `og-qsys-app`

## Required app env

```bash
PORT=3100
NODE_ENV=production
APP_BASE_PATH=/qsys
SESSION_SECRET=<strong-random-secret>
BRANCH_CODE=OG
QSYS_DATA_DIR=/var/lib/qsys
```

## Nginx config file

- host path: `/opt/og-inventory/infra/nginx/default.prod.conf`
- mounted in container as: `/etc/nginx/conf.d/default.conf`

## HTTP redirect

```nginx
server {
    listen 80;
    server_name inventory.onegourmetph.com onegourmetph.com www.onegourmetph.com;
    return 301 https://$host$request_uri;
}
```

## HTTPS reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name onegourmetph.com www.onegourmetph.com inventory.onegourmetph.com;

    ssl_certificate /etc/nginx/certs/onegourmetph.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/onegourmetph.com/privkey.pem;

    include /etc/nginx/snippets/ssl-params.conf;

    location = /qsys {
        return 301 /qsys/;
    }

    location /qsys/socket.io/ {
        proxy_pass http://og-qsys-app:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }

    location /qsys/ {
        proxy_pass http://og-qsys-app:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300;
    }

    location /api/ {
        proxy_pass http://api:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## Certificate paths

- Let's Encrypt source:
  - `/etc/letsencrypt/live/onegourmetph.com/fullchain.pem`
  - `/etc/letsencrypt/live/onegourmetph.com/privkey.pem`
- Docker-mounted copy:
  - `/opt/og-inventory/infra/nginx/certs/onegourmetph.com/fullchain.pem`
  - `/opt/og-inventory/infra/nginx/certs/onegourmetph.com/privkey.pem`

## Renewal sync

- sync script:
  - `/opt/og-inventory/infra/nginx/sync-letsencrypt.sh`
- root cron:

```cron
15 3 * * * certbot renew --quiet && /opt/og-inventory/infra/nginx/sync-letsencrypt.sh
```

## Verified URLs

- `https://onegourmetph.com/qsys/test`
- `https://onegourmetph.com/qsys/api/health`
- `https://onegourmetph.com/qsys/guest`
- `https://onegourmetph.com/qsys/staff`
- `https://onegourmetph.com/qsys/admin`
- `https://onegourmetph.com/qsys/admin-login`

## Optional clean subdomains

Use reverse proxying for these subdomains. Do not point `root` at separate
folders like `/var/www/html/qsys/staff-login`; QSYS is one Node app with shared
API routes, Socket.IO, files, sessions, and SQLite data.

Recommended hostnames:

- `https://guest.onegourmetph.com`
- `https://staff.onegourmetph.com`
- `https://admin.onegourmetph.com`

Run a second QSYS service/container for the subdomains with the same image and
the same `QSYS_DATA_DIR`, but with no base path:

```bash
PORT=3101
NODE_ENV=production
APP_BASE_PATH=
SESSION_SECRET=<same-secret-as-main-qsys>
BRANCH_CODE=OG
QSYS_DATA_DIR=/var/lib/qsys
QSYS_GUEST_HOST=guest.onegourmetph.com
QSYS_STAFF_HOST=staff.onegourmetph.com
QSYS_ADMIN_HOST=admin.onegourmetph.com
```

If using `docker-compose.qsys.yml`, copy `.env.qsys.subdomains.example` to
`.env.qsys.subdomains`; that compose setup mounts the shared data volume at
`/data`, so keep `QSYS_DATA_DIR=/data` there.

The existing `/qsys` service can stay as-is on port `3100` with
`APP_BASE_PATH=/qsys`.

Add the subdomains to the TLS certificate, for example:

```bash
certbot certonly --nginx \
  -d onegourmetph.com \
  -d www.onegourmetph.com \
  -d guest.onegourmetph.com \
  -d staff.onegourmetph.com \
  -d admin.onegourmetph.com
```

Example Nginx server block:

```nginx
server {
    listen 80;
    server_name guest.onegourmetph.com staff.onegourmetph.com admin.onegourmetph.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name guest.onegourmetph.com staff.onegourmetph.com admin.onegourmetph.com;

    ssl_certificate /etc/nginx/certs/onegourmetph.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/onegourmetph.com/privkey.pem;

    include /etc/nginx/snippets/ssl-params.conf;

    location /socket.io/ {
        proxy_pass http://og-qsys-subdomains:3101;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://og-qsys-subdomains:3101;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300;
    }
}
```

With the host-aware routing in the app:

- `staff.onegourmetph.com/` shows staff login, then the staff screen.
- `admin.onegourmetph.com/` shows admin login, then the admin screen.
- `guest.onegourmetph.com/` redirects to `/?branchCode=<default-branch>` and
  shows guest registration.
- branch QR links use `guest.onegourmetph.com/?branchCode=<branch>`.

## Useful checks

```bash
docker exec og_nginx nginx -t
docker exec og_nginx nginx -s reload
docker logs og-qsys-app --tail 100
curl -I https://onegourmetph.com/qsys/test
curl -I https://onegourmetph.com/qsys/api/health
```
