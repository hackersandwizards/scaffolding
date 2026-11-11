#!/bin/zsh
# usage: watch.sh <run dir>
# Prints one line per run of <run dir>/runs that finished since the last line, a run whose run.sh
# is gone without writing `EXIT` included, and exits when none is left running and no net-watch.sh
# watches <run dir>, which may still relaunch one.
cd ${1:a} || exit 1
# The run.sh that <name>.pid names is alive and runs <name>.
up(){ local p=$(cat $1.pid 2>/dev/null); [[ -n $p && $(ps -ww -o command= -p $p 2>/dev/null) == *run.sh\ *\ $1\ * ]]; }
# The net-watch.sh that .net-watch.pid names is alive and watches this folder.
watched(){ local p=$(cat .net-watch.pid 2>/dev/null); [[ -n $p && $(ps -ww -o command= -p $p 2>/dev/null) == *net-watch.sh* &&
  $(lsof -a -d cwd -p $p -Fn 2>/dev/null | sed -n 's/^n//p') == ${PWD:A} ]]; }
while true; do
  left=0
  for l in ${(f)"$(cat runs 2>/dev/null)"}; do
    read -r n d a x <<<$l
    # Sampled before the EXIT read: run.sh writes EXIT, then ends.
    up $n && u=1 || u=0
    if grep -aq '^EXIT ' $n.log 2>/dev/null; then
      [ -e .notified-$n ] || { touch .notified-$n; echo "$n finished: $(grep -a '^EXIT' $n.log | tail -1)"; }
    elif [ -f $n.log ] && [ -s $n.pid ] && (( ! u )) && ! lsof -t -- $n.log >/dev/null 2>&1; then
      [ -e .notified-$n ] || { touch .notified-$n; echo "$n ended without EXIT"; }
    else left=$((left+1)); fi
  done
  [ $left -eq 0 ] && ! watched && { echo "no run left"; exit 0; }
  sleep 30
done
