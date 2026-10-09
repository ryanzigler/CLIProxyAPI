FROM oven/bun:1.3.14 AS web

WORKDIR /web

COPY web/package.json web/bun.lock ./

RUN bun install --frozen-lockfile

COPY web/ ./

ARG VERSION=dev

RUN VERSION=${VERSION} bun run build

FROM golang:1.26-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends build-essential git && rm -rf /var/lib/apt/lists/*

COPY go.mod go.sum ./

RUN go mod download

COPY . .

ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_DATE=unknown

RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false -ldflags="-s -w -X 'main.Version=${VERSION}' -X 'main.Commit=${COMMIT}' -X 'main.BuildDate=${BUILD_DATE}'" -o ./CLIProxyAPI ./cmd/server/

FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /CLIProxyAPI/static

COPY --from=builder ./app/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI

COPY --from=web /web/dist/index.html /CLIProxyAPI/static/management.html

COPY config.example.yaml /CLIProxyAPI/config.example.yaml

WORKDIR /CLIProxyAPI

EXPOSE 8317

# The console is built from web/ above; never replace it with upstream's release.
ENV MANAGEMENT_STATIC_PATH=/CLIProxyAPI/static/management.html \
    MANAGEMENT_PANEL_BAKED=1 \
    TZ=UTC

RUN cp /usr/share/zoneinfo/${TZ} /etc/localtime && echo "${TZ}" > /etc/timezone

CMD ["./CLIProxyAPI", "-config", "/config/config.yaml"]
