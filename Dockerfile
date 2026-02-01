FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /codenavigator .

FROM alpine:3.22
# git is needed at runtime to clone GitHub repositories.
RUN apk add --no-cache git ca-certificates && adduser -D -H app
COPY --from=build /codenavigator /usr/local/bin/codenavigator
USER app
ENV PORT=4177
EXPOSE 4177
HEALTHCHECK CMD wget -qO- http://127.0.0.1:$PORT/api/health || exit 1
ENTRYPOINT ["codenavigator"]
