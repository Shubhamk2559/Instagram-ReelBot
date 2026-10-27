#!/bin/sh
# Koyeb web service entrypoint: migrations -> (optional) reelbot in background -> Node web server.
node server/dist/db/migrate.js || exit 1

if [ -n "$ACCOUNTS_JSON" ]; then
  (
    while true; do
      /opt/venv/bin/python reelbot/reel_bot.py run
      echo "reelbot exited, restarting in 30s"
      sleep 30
    done
  ) &
else
  echo "ACCOUNTS_JSON not set: reelbot disabled"
fi

exec node server/dist/index.js
