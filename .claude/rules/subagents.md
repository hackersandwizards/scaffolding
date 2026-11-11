# Subagents

Load `delegation` before launching a background delegate or a `claude -p` run: it holds the launch,
wait, stop and review mechanics. Load `parallel-session` before fanning out a third delegate or
leaving a session running for the person's return.

- Running unattended, say so in every subagent prompt you write: a fresh delegate otherwise stops
  to ask.
- Delegating never widens scope. Name the work in the prompt; anything the delegate judges to need
  more comes back as a decision for the principal.
- Carry the person's request into the brief in their own words and mark your own framing: a
  delegate answers the question the brief asks.
- Before a brief states what a file, release or checkout holds, or repeats a point from an earlier
  report, run the command that shows it in the turn that writes the brief. What you did not check
  goes in as an assumption the delegate tests.
- A brief yields to a rule and to the channel's skill, and the delegate names the instruction it
  skipped. A brief naming a channel lets the delegate draft there.
- The colleague holding a case drafts its outbound message itself through the channel's skill.
- A delegate reviewing credential handling reasons from the source: no command that reads a
  keychain, a credential helper or a secret store.
- Every brief names its run's scratch folder. A delegate started through the Agent tool never runs
  `rm`: it lists its scratch paths, and you delete them by literal path.
- Delegate only work that needs little from the rest of the session and hands back a compact
  result.
