#!/usr/bin/env bash
# Sequential <=20-file committer. Runs in the FOREGROUND (no background, no tail pipe)
# so there is exactly one instance. Aborts on first failure.
set -u
cd /d/Portable/khy-os || exit 1
LIST="$1"; MSG="$2"; CHUNK=20
[ -f "$LIST" ] || { echo "no list $LIST"; exit 1; }
total=$(wc -l < "$LIST")
n=$(( (total + CHUNK - 1) / CHUNK ))
echo "### $(basename "$LIST"): $total files -> $n commit(s)"
i=0
while [ "$i" -lt "$n" ]; do
  start=$(( i * CHUNK + 1 ))
  cf="/tmp/p4/_chunk.txt"
  sed -n "${start},$(( start + CHUNK - 1 ))p" "$LIST" > "$cf"
  got=$(wc -l < "$cf")
  git reset -q
  git add --pathspec-from-file="$cf" 2>/dev/null
  staged=$(git diff --cached --name-only | wc -l)
  if [ "$staged" -ne "$got" ] || [ "$staged" -gt "$CHUNK" ]; then
    echo "!!! chunk $i: got=$got staged=$staged — ABORT"; exit 1
  fi
  printf '%s\n\n本批 %d/%d（每批 ≤%d 件，符合 SECURITY-001 门槛）。回滚：git revert <本commit>\n' \
    "$MSG" "$(( i + 1 ))" "$n" "$CHUNK" > /tmp/p4/_msg.txt
  if ! git commit -F /tmp/p4/_msg.txt > /tmp/p4/_log.txt 2>&1; then
    echo "!!! chunk $i commit FAILED"; tail -15 /tmp/p4/_log.txt; exit 1
  fi
  echo "  [$(( i + 1 ))/$n] $(git log --oneline -1 | cut -c1-64)"
  i=$(( i + 1 ))
done
echo "### done $(basename "$LIST")"
