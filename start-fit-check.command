#!/bin/zsh
cd "$(dirname "$0")"
if [[ ! -f .env && -z "$GEMINI_API_KEY" ]]; then
  read -s "GEMINI_API_KEY?Gemini API 키를 입력하세요: "
  export GEMINI_API_KEY
  echo
fi
node server.mjs &
server_pid=$!
sleep 0.5
open http://localhost:4173
wait $server_pid
