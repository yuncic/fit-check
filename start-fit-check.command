#!/bin/zsh
cd "$(dirname "$0")"
if [[ ! -f .env && -z "$ANTHROPIC_API_KEY" ]]; then
  read -s "ANTHROPIC_API_KEY?Claude API 키를 입력하세요: "
  export ANTHROPIC_API_KEY
  echo
fi
node server.mjs &
server_pid=$!
sleep 0.5
open http://localhost:4173
wait $server_pid
