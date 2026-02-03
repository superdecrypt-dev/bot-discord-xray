OUT="bot-discord-xray.tar.gz"
rm -f "$OUT"

tar -czf "$OUT" \
  --transform='s|^|bot-discord-xray/|' \
  --exclude='bot/node_modules' \
  --exclude='**/__pycache__' \
  --exclude='**/*.pyc' \
  backend bot
