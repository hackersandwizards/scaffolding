#!/bin/zsh
# usage, detached: nohup net-watch.sh <run dir> </dev/null >/dev/null 2>&1 &
# Relaunches a run of <run dir>/runs (one `<name> <repo dir> <account>` line each, read every
# minute) that ended non-zero, not by a stop (143), with a connection failure in its last lines,
# once the API answers again; at most four times a run, for two days, and exits once every listed
# run has ended. One instance per run dir: a start stops the instance .net-watch.pid names, once
# that process's command line and working directory show it is this dir's watcher, and waits up
# to 30 s for the relaunch it may be in to finish. DRY=1 checks once and relaunches nothing.
S=${1:a}; cd $S || exit 1
R=${0:a:h}
# A stop takes effect between two runs, never inside a relaunch.
trap 'stop=1' TERM
if [ "$DRY" != 1 ]; then
  o=$(cat .net-watch.pid 2>/dev/null)
  echo $$ > .net-watch.pid
  [[ -n $o && $o != $$ && $(ps -ww -o command= -p $o 2>/dev/null) == *net-watch.sh* &&
    $(lsof -a -d cwd -p $o -Fn 2>/dev/null | sed -n 's/^n//p') == ${S:A} ]] && kill $o &&
    for i in {1..150}; do kill -0 $o 2>/dev/null && sleep 0.2 || break; done
fi
NOTE="

A previous run of this brief was cut off by a lost internet connection: read git log, origin/main and the working tree for what it already committed or left, finish from there, never redo committed work, and push what it could not push."
online(){ [ "$DRY" = 1 ] && return 0; [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.anthropic.com/)" != 000 ]; }
died(){
  grep -aqE '^EXIT (0|143)$' $1.log && return 1
  tail -c 600 $1.log | grep -aqiE 'Connection error|ECONNRESET|ENOTFOUND|Unable to connect|fetch failed|could not resolve host'
}
# The run.sh that <name>.pid names is alive and runs <name>.
up(){ local p=$(cat $1.pid 2>/dev/null); [[ -n $p && $(ps -ww -o command= -p $p 2>/dev/null) == *run.sh\ *\ $1\ * ]]; }
end=$(( $(date +%s) + 172800 ))
while [ $(date +%s) -lt $end ]; do
  left=0; [ -s runs ] || left=1
  for l in ${(f)"$(cat runs 2>/dev/null)"}; do
    read -r n d a x <<<$l
    (( stop )) && exit 0
    [ -f $n.log ] || { left=1; continue }
    # Sampled before the EXIT read: run.sh writes EXIT, then ends.
    up $n && u=1 || u=0
    if ! grep -aq '^EXIT ' $n.log; then
      # Ended without EXIT: its run.sh is gone and nothing holds the log open.
      [ -s $n.pid ] && (( ! u )) && ! lsof -t -- $n.log >/dev/null 2>&1 || left=1
      continue
    fi
    (( u )) && { left=1; continue }
    died $n || continue
    c=$(cat .retries-$n 2>/dev/null || echo 0)
    # A line short of its repo or account names no run to relaunch.
    [[ $c -ge 4 || -z $a ]] && continue
    left=1
    online || continue
    msg="$(date '+%H:%M:%S') relaunch $n ($((c+1)))"
    [ "$DRY" = 1 ] && { echo $msg; continue }
    echo $msg >> net-watch.log
    echo $((c+1)) > .retries-$n
    mv $n.log $n.log.$c
    (( c )) || print -r -- "$NOTE" >> $n.md
    (nohup $R/run.sh $S $n $d $a </dev/null >/dev/null 2>&1 &)
  done
  [ "$DRY" = 1 ] && exit 0
  (( left && ! stop )) || exit 0
  # wait returns above 128 when the stop cut it short, the sleep still alive.
  sleep 60 & wait $! || kill $! 2>/dev/null
  (( stop )) && exit 0
done
