#!/bin/sh
# Koyeb web service entrypoint: migrations -> Node web server (which also runs the official-API publisher).
node server/dist/db/migrate.js || exit 1
exec node server/dist/index.js
