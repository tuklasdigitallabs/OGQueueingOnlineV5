# QSYS VPS Nginx Setup

This setup keeps the main website on `/` and forwards only `/qsys` to the QSYS app.

## Assumed VPS layout

- app repo checkout: `/opt/og-qsys/app`
- runtime folder: `/opt/og-qsys`
- Nginx container name: `og_nginx`
- QSYS container name: `og-qsys-app`

## Required app env

```bash
PORT=3000
NODE_ENV=production
APP_BASE_PATH=/qsys
SESSION_SECRET=<strong-random-secret>
BRANCH_CODE=OG
QSYS_DATA_DIR=/var/lib/qsys
```

## Nginx reverse proxy

```nginx
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
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}

location /qsys/ {
    proxy_pass http://og-qsys-app:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300;
}
```

## Test URLs

- `http://onegourmetph.com/qsys/test`
- `http://onegourmetph.com/qsys/api/health`
