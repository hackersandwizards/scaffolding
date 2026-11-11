#!/bin/zsh
# usage, detached from a foreground call:
#   nohup run.sh <run dir> <name> <repo dir> <account> </dev/null >/dev/null 2>&1 &
# Runs one unattended claude -p in <repo dir> on cswap account <account>. The prompt is
# <run dir>/<name>.md, then common.md (or the file <name>.common names). The log is <name>.log,
# whose last line is `EXIT <status>`, 143 where the run was stopped (TERM, HUP or INT); <name>.pid
# holds this script's pid, written before the log.
# Model and effort: <name>.model ("<model> <effort>"), else Opus medium. Every launch names its
# model; ANTHROPIC_MODEL carries it into nested claude -p calls.
S=${1:a}; name=$2; dir=$3; acct=$4
{ read -r model effort < $S/$name.model } 2>/dev/null
: ${model:=claude-opus-5-5} ${effort:=medium}
[ -s $S/$name.md ] && cd $dir || { echo "no brief or repo: $S/$name.md $dir\nEXIT 1" > $S/$name.log; exit 1; }
# Set before the pid file names this script: a stop from then on ends in EXIT 143, never in an orphaned run.
trap 'stopped=1; kill $pid 2>/dev/null' TERM HUP INT
rm -f $S/.notified-$name; echo $$ > $S/$name.pid; : > $S/$name.log
P="$(cat $S/$name.md)

$(cat $S/$(cat $S/$name.common 2>/dev/null || echo common.md))

Model: this run is on $model at effort $effort. Every nested \`claude -p\` you start names its model: \`--model $model --effort $effort\` for your own review skills, and \`--model claude-opus-5-5 --effort medium\` for a blind-review persona unless your brief names another reviewer model. A call without \`--model\` takes the machine's default, so its scores are not comparable."
# cswap execs claude, so the stop reaches the run itself; one between the launch and pid=$! is caught
# on the next line. With no launch, wait returns at once; the second wait lets the run end before EXIT.
(( stopped )) || { ANTHROPIC_MODEL=$model CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 cswap run $acct -- -p "$P" --model $model --effort $effort --fallback-model claude-opus-5-5 --permission-mode bypassPermissions > $S/$name.log 2>&1 </dev/null & pid=$! }
(( stopped )) && kill $pid 2>/dev/null
wait $pid; rc=$?
wait $pid 2>/dev/null; (( stopped )) && rc=143
echo "EXIT $rc" >> $S/$name.log
