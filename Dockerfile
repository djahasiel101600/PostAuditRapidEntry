# syntax=docker/dockerfile:1
# rci-gateway — builds the SPA and serves it (plus reverse-proxy for the API)
# with nginx. Reached ONLY through the shared "office-network" (Cloudflare
# tunnel ingress -> http://rci-gateway:80). No host port is published.

FROM node:22-alpine AS build
WORKDIR /app

# No package-lock.json in the repo; mirror local install flags.
COPY package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY . .

# Google Identity Services client id is baked in at build time.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Internal-only listener; never published to the host.
EXPOSE 80
