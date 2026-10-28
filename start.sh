#!/bin/sh
# Koyeb web service entrypoint: migrations -> reelbot worker in background -> Node web server.
node server/dist/db/migrate.js || exit 1

if [ "$REELBOT_DISABLED" != "true" ]; then
  (
    while true; do
      /opt/venv/bin/python reelbot/reel_bot.py run
      echo "reelbot exited, restarting in 30s"
      sleep 30
    done
  ) &
else
  echo "REELBOT_DISABLED=true: session-ID worker off"
fi

exec node server/dist/index.js
