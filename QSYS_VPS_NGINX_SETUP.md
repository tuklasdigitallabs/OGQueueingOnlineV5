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

## Useful checks

```bash
docker exec og_nginx nginx -t
docker exec og_nginx nginx -s reload
docker logs og-qsys-app --tail 100
curl -I https://onegourmetph.com/qsys/test
curl -I https://onegourmetph.com/qsys/api/health
```
