#!/bin/bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
while true; do
  node bot.js
  echo "Bot stopped - restarting in 10 seconds. Press Ctrl+C to stop."
  sleep 10
done
