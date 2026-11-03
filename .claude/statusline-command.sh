#!/usr/bin/env bash
# shellcheck disable=SC2154
# (extract/pct_color/time_color/render_bar assign via `printf -v "$var"`, which
#  the linter cannot trace, so it flags every consumer as unset.)
#
#   [Project ·] [Branch* ·] [(REBASING 3/7) ·] [ahead/behind ·] [Agent ·] Model · [Effort ·] context bar XX% · [rate-limit bar XX% Xh Xm] [· account] [· $cost] [· status]
#
# Colors match the starship prompt; effort badges match Claude's UI.

ESC=$'\033'
RESET="${ESC}[0m"
CYAN="${ESC}[36m"
GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"
BLUE="${ESC}[34m"
RED="${ESC}[31m"
MAGENTA="${ESC}[35m"
GRAY="${ESC}[90m"
ORANGE="${ESC}[38;2;230;130;50m"
GOLD="${ESC}[38;2;220;200;60m"
SKY="${ESC}[38;2;110;180;200m"

FILLED="██████████"
EMPTY="░░░░░░░░░░"
SEP="${GRAY}·${RESET}"

# Claude reports "% context used" against the auto-compact threshold, not the full
# window. As of cli v2.1.156: window - min(maxOutput, 20000) - 13000, and maxOutput
# caps at 8000, so the reserve is a fixed 21000 tokens at any window size. Not in the
# statusline JSON: re-sync if Anthropic changes the constants.
CTX_RESERVE_TOKENS=21000
# Warn at 150k and 250k live tokens, each capped at a share of the usable window
# (yellow 75%, red 90%) so a 200k window still warns before auto-compact.
CTX_YELLOW_TOKENS=150000  CTX_RED_TOKENS=250000
CTX_YELLOW_CAP=75  CTX_RED_CAP=90

RL5_RED=80   RL5_YELLOW=50

STATUS_CACHE_TTL=300   STATUS_FETCH_TIMEOUT=5

# $TMPDIR is mode 700 on macOS. The /tmp fallback is not, so every value read
# back out of these caches is validated before use.
CACHE_DIR="${TMPDIR:-/tmp}"
CACHE_DIR="${CACHE_DIR%/}"

format_countdown() {
    local secs="$1" var="$2"
    if (( secs <= 0 )); then printf -v "$var" '%s' "0m"
    elif (( secs < 3600 )); then printf -v "$var" '%s' "$((secs / 60))m"
    elif (( secs < 86400 )); then printf -v "$var" '%s' "$((secs / 3600))h$((secs % 3600 / 60))m"
    else printf -v "$var" '%s' "$((secs / 86400))d$((secs % 86400 / 3600))h"
    fi
}

extract() {
    local pat="$1" var="$2" def="$3" src="${4-$input}"
    if [[ $src =~ $pat ]]; then printf -v "$var" '%s' "${BASH_REMATCH[1]}"
    else                        printf -v "$var" '%s' "$def"
    fi
}

render_bar() {
    local color="$1" idx="$2" pct="$3" var="$4"
    printf -v "$var" '%s%s%s%s %s%s%%%s' \
        "$color" "${FILLED:0:idx}" "$RESET" "${EMPTY:idx}" \
        "$color" "$pct" "$RESET"
}

pct_color() {
    local pct="$1" red="$2" yellow="$3" var="$4"
    if   (( pct >= red    )); then printf -v "$var" '%s' "$RED"
    elif (( pct >= yellow )); then printf -v "$var" '%s' "$YELLOW"
    else                            printf -v "$var" '%s' "$GREEN"
    fi
}

# Color the rate-limit countdown by how alarming the burn rate is: high usage with
# hours still to burn is the alarming case, near-reset is not.
time_color() {
    local pct="$1" secs="$2" var="$3"
    if (( pct >= 80 )); then
        if   (( secs > 3600 ));  then printf -v "$var" '%s' "$RED"
        elif (( secs > 1200 ));  then printf -v "$var" '%s' "$YELLOW"
        else                          printf -v "$var" '%s' "$GREEN"
        fi
    elif (( pct >= 50 )); then
        if   (( secs > 7200 ));  then printf -v "$var" '%s' "$YELLOW"
        elif (( secs <= 1800 )); then printf -v "$var" '%s' "$GREEN"
        else                          printf -v "$var" '%s' "$GRAY"
        fi
    else
        printf -v "$var" '%s' "$GRAY"
    fi
}

IFS= read -r -d '' input

now=${EPOCHSECONDS:-$(date +%s)}

extract '"project_dir":"([^"]+)"'                       project_dir ""
project_dir="${project_dir##*/}"
extract '"display_name":"([^"]+)"'                      model       "Claude"
extract '"agent":\{[^}]*"name":"([^"]+)"'               agent       ""
extract '"context_window_size":([0-9]+)'                ctx_size    200000
extract '"effort":\{[^}]*"level":"([^"]+)"'             effort      ""
extract '"five_hour":\{[^}]*"used_percentage":([0-9]+)' rl5_pct     ""
extract '"five_hour":\{[^}]*"resets_at":([0-9]+)'       rl5_resets  ""
extract '"total_cost_usd":([0-9]+(\.[0-9]+)?)[,}]'      cost_usd    ""

# .claude.json is 160 KB with emailAddress near the end, so the answer is cached.
# An account switch rewrites the file, so mtime invalidates the cache. Keyed by
# source path: a session pinned to another CLAUDE_CONFIG_DIR keeps its own entry.
acct_file="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
acct_cache="$CACHE_DIR/claude-statusline-account${acct_file//\//-}.cc"
account=""
if [[ $acct_file -nt $acct_cache ]]; then
    # The local part alone collides across accounts held in one name; the first
    # domain label separates them and the rest carries no signal.
    extract '"emailAddress"[[:space:]]*:[[:space:]]*"([^@"]+@[^."]+)' account "" \
            "$(grep -oE '"emailAddress"[[:space:]]*:[[:space:]]*"[^"]*"' "$acct_file" 2>/dev/null)"
    printf '%s\n' "$account" > "$acct_cache.tmp" && mv "$acct_cache.tmp" "$acct_cache"
elif [[ -f $acct_cache ]]; then
    read -r account < "$acct_cache"
fi
[[ $account =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+$ ]] || account=""

# Claude excludes output_tokens from context usage. Strip rate_limits first so the token
# regexes only see the context-window block; "input_tokens" does not match inside
# "total_input_tokens"/"cache_*_input_tokens" (no leading quote there).
ctx_only="${input%%\"rate_limits\"*}"
extract '"input_tokens":([0-9]+)'                tok_input  0  "$ctx_only"
extract '"cache_creation_input_tokens":([0-9]+)' tok_cc     0  "$ctx_only"
extract '"cache_read_input_tokens":([0-9]+)'     tok_cr     0  "$ctx_only"
tokens=$(( tok_input + tok_cc + tok_cr ))

git_dir="" git_state=""
branch="" dirty="" ahead="" behind=""
dir=$PWD
while [[ $dir && $dir != / ]]; do
    if [[ -d $dir/.git ]]; then
        git_dir=$dir/.git; break
    elif [[ -f $dir/.git ]]; then
        gitdir_pointer=$(< "$dir/.git")
        git_dir=${gitdir_pointer#gitdir: }
        [[ $git_dir == /* ]] || git_dir=$dir/$git_dir
        break
    fi
    dir=${dir%/*}
done

if [[ -n $git_dir ]]; then
    # --no-optional-locks: runs every render; don't take index.lock under foreground git.
    git_status=$(git --no-optional-locks status --porcelain -b 2>/dev/null)
    if [[ -n $git_status ]]; then
        # A "." in the exclusion class would truncate dotted branches (release-1.2).
        [[ $git_status =~ ^##\ ([^$'\n']+) ]] && branch="${BASH_REMATCH[1]%%...*}"
        [[ $git_status == *$'\n'* ]] && dirty=1
        [[ $git_status =~ ahead\ ([0-9]+) ]] && ahead="${BASH_REMATCH[1]}"
        [[ $git_status =~ behind\ ([0-9]+) ]] && behind="${BASH_REMATCH[1]}"
    fi
    if [[ -d $git_dir/rebase-merge ]]; then
        git_state="REBASING $(< "$git_dir/rebase-merge/msgnum")/$(< "$git_dir/rebase-merge/end")"
    elif [[ -d $git_dir/rebase-apply ]]; then
        git_state="REBASING $(< "$git_dir/rebase-apply/next")/$(< "$git_dir/rebase-apply/last")"
    elif [[ -f $git_dir/MERGE_HEAD ]]; then       git_state="MERGING"
    elif [[ -f $git_dir/CHERRY_PICK_HEAD ]]; then git_state="CHERRY-PICKING"
    elif [[ -f $git_dir/REVERT_HEAD ]]; then      git_state="REVERTING"
    elif [[ -f $git_dir/BISECT_LOG ]]; then       git_state="BISECTING"
    fi
fi

# "% context used" exactly as Claude renders it: 100 - round(remaining/usable).
usable=$(( ctx_size - CTX_RESERVE_TOKENS ))
(( usable < 1 )) && usable=1
if (( tokens >= usable )); then
    pct=100
else
    pct=$(( 100 - ( ( (usable - tokens) * 100 + usable / 2 ) / usable ) ))
fi

bar_idx=$(( pct / 10 ))
# Token thresholds as "% used" of this session's usable window, rounded up.
ctx_threshold() { # tokens cap var
    local t=$(( $1 < usable * $2 / 100 ? $1 : usable * $2 / 100 ))
    printf -v "$3" '%s' "$(( (t * 100 + usable - 1) / usable ))"
}
ctx_threshold "$CTX_RED_TOKENS" "$CTX_RED_CAP" ctx_red
ctx_threshold "$CTX_YELLOW_TOKENS" "$CTX_YELLOW_CAP" ctx_yellow
pct_color "$pct" "$ctx_red" "$ctx_yellow" bar_color

# Trailing " ${SEP} " means "more may follow"; leading means "only join if something
# rendered before us". The inconsistency is load-bearing.

out=""

[[ -n $project_dir ]] && out+="${CYAN}${project_dir}${RESET} ${SEP} "
if [[ -n $branch ]]; then
    out+="${GRAY}${branch}${RESET}"
    [[ -n $dirty ]] && out+="${RED}*${RESET}"
    out+=" ${SEP} "
fi
[[ -n $git_state ]] && out+="${YELLOW}(${git_state})${RESET} ${SEP} "
if [[ -n $ahead || -n $behind ]]; then
    [[ -n $ahead ]] && out+="${GRAY}↑${ahead}${RESET}"
    [[ -n $behind ]] && out+="${GRAY}↓${behind}${RESET}"
    out+=" ${SEP} "
fi

[[ -n $agent ]] && out+="${ORANGE}${agent}${RESET} ${SEP} "
out+="${CYAN}${model}${RESET}"
out+=" ${SEP} "
if [[ -n $effort ]]; then
    case "$effort" in
        low)    out+="${YELLOW}low${RESET}" ;;
        medium) out+="${GREEN}med${RESET}" ;;
        high)   out+="${BLUE}high${RESET}" ;;
        xhigh)  out+="${MAGENTA}xhigh${RESET}" ;;
        max)    out+="${ORANGE}m${GOLD}a${SKY}x${RESET}" ;;
        *)      out+="${GRAY}${effort}${RESET}" ;;
    esac
    out+=" ${SEP} "
fi

render_bar "$bar_color" "$bar_idx" "$pct" ctx_bar
out+="$ctx_bar"
if [[ -n $rl5_pct ]]; then
    rl5_idx=$(( rl5_pct / 10 ))
    pct_color "$rl5_pct" "$RL5_RED" "$RL5_YELLOW" rl5_color
    rl5_secs=$(( rl5_resets - now ))
    format_countdown "$rl5_secs" rl5_time
    time_color "$rl5_pct" "$rl5_secs" rl5_time_color
    render_bar "$rl5_color" "$rl5_idx" "$rl5_pct" rl5_bar
    out+=" ${SEP} ${rl5_bar} ${rl5_time_color}${rl5_time}${RESET}"
fi

[[ -n $account ]] && out+=" ${SEP} ${GRAY}${account}${RESET}"
# %f reads and writes under LC_NUMERIC: a comma-decimal locale both rejects the
# JSON number and prints the wrong one.
LC_ALL=C printf -v cost_disp "\$%.2f" "${cost_usd:-0}"
[[ $cost_disp != "\$0.00" ]] && out+=" ${SEP} ${GRAY}${cost_disp}${RESET}"

# Caches the component status string alone, so the hot path never regexes a 30 KB
# JSON.
status_cache="$CACHE_DIR/claude-statusline-status.cc"
status_expiry_file="$CACHE_DIR/claude-statusline-status.expiry"
status_expiry=0
# Guard the read: `< missing 2>/dev/null` still leaks an "No such file" error
# because the input redirect is opened before 2>/dev/null takes effect.
[[ -f "$status_expiry_file" ]] && read -r status_expiry < "$status_expiry_file"
[[ $status_expiry =~ ^[0-9]+$ ]] || status_expiry=0
if (( now >= status_expiry )); then
    # Pre-write next expiry so parallel renders don't all spawn fetches; also
    # debounces retries when the upstream is unreachable (curl fails -> cache stays).
    echo $(( now + STATUS_CACHE_TTL )) > "$status_expiry_file"
    (
        resp=$(curl -s --max-time "$STATUS_FETCH_TIMEOUT" "https://status.claude.com/api/v2/summary.json")
        if [[ $resp =~ \"name\":\"Claude\ Code\"[^}]*\"status\":\"([^\"]+)\" ]]; then
            printf '%s' "${BASH_REMATCH[1]}" > "${status_cache}.tmp" \
                && mv "${status_cache}.tmp" "$status_cache"
        fi
    ) >/dev/null 2>&1 &
fi
if [[ -s $status_cache ]]; then
    read -r cc_status < "$status_cache"
    case "$cc_status" in
        operational|"")       label="" ;;
        degraded_performance) label="${YELLOW}degraded" ;;
        partial_outage)       label="${YELLOW}partial outage" ;;
        major_outage)         label="${RED}major outage" ;;
        under_maintenance)    label="${YELLOW}maintenance" ;;
        *)                    label="" ;;
    esac
    [[ -n $label ]] && out+=" ${SEP} ${label}${RESET}"
fi

printf '%s\n' "$out"
