# A scheduled run's hand-over

A scheduled run that names this file hands its run over, waits and cleans up this way.

Where this session runs on a Haiku model, the Agent call carries `model: "opus"` and
`effort: "medium"`, or the effort the task names. On any other model it carries neither, and the
delegate runs on this session's model. A delegate reporting only `wrong model` ran on Haiku:
launch it again with those two parameters.

Add these three paragraphs to the instruction, `<scratchpad>` replaced by this session's scratchpad
path and `<task>` by the task's name:

> Your scratch folder is `<scratchpad>/<task>/`: create it first, write every scratch file there,
> never in `/tmp`, run no `rm`, and list in your report every scratch path your run created outside
> it.
>
> Wait in the foreground for every command you start in the background, and end your turn only with
> your report: the session that launched you reads the end of your turn as the end of the run.
>
> Where the model you run on is a Haiku model, do no work and report only `wrong model`.

Once the report is in and no delegate of this session still runs, delete the scratch folder and
each scratch path the report lists outside it by its literal path. Where the delegate fails or is
stopped before reporting, your report says so and names the last step its transcript reached.

To wait: the Agent call returns a launch result at once, and the report arrives later as a task
notification. Do not end your turn before it arrives: while your turn is open the scheduler holds the
task's next run (Claude Desktop skips it, T3 queues it). Once it ends, Claude Desktop starts the
next run beside the delegate, and in T3 the delegate can no longer start a child thread
(`Parent run ... is not active`). T3's `t3_background_wait` takes no subagent's id. Take the
`output_file` path from the launch result and run this foreground Bash command with
`timeout: 600000`:

```bash
m=$(readlink "<output_file>"); m=${m%.jsonl}.meta.json; n=0; if [ ! -f "$m" ]; then echo ERROR; else until jq -e '.finished == true' "$m" >/dev/null 2>&1 || [ $n -ge 48 ]; do sleep 10; n=$((n+1)); done; jq -e '.finished == true' "$m" >/dev/null 2>&1 && echo finished || echo running; fi
```

Repeat it while it prints `running`, at most six times; a result saying the command was moved to
the background counts as `running`, and you run it again in the foreground. On `finished`, the
report follows as the notification. After the sixth `running`, report that the delegate is still
running and end with outcome deferred. On `ERROR`, the wait cannot be read: end the turn and relay
the report when the notification arrives after it.
