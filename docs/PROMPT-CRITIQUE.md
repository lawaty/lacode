# Prompt critique

> **Beta.** `promptCritique` ships on the npm `beta` dist-tag. It is off by
> default and changes nothing until you enable it.

Prompt critique makes the primary and planner agents check your request against
the global standards before they act. When you enable it, LaCode prepends a short
instruction to the prompts of those agents. The agent then warns you plainly when
your prompt, proposal, or recommendation conflicts with a global rule, an
architectural decision, or a project convention — and names the rule and file it
conflicts with — instead of silently following the request. If a materially
better recommendation follows from the standards, the agent says so with the
trade-off.

It is advisory, not a veto. The agent must still carry out what you asked unless
you change your mind; it may not refuse, block, or silently substitute its own
preference.

## Enabling it

```jsonc
{
  "plugin": [
    ["@lawaty/lacode", { "promptCritique": true }]
  ]
}
```

The option is a plugin option on the LaCode entry, alongside `yolo` and `ykb`.
The default is `false`.

## Which agents it reaches

| Agent | Receives the instruction |
| --- | --- |
| `build` | yes |
| `plan` | yes |
| `basic` (user-defined) | yes, when present |
| `expert` (user-defined) | yes, when present |
| `explore`, `implement`, `context` | no |
| `instructions` (hidden writer) | no |
| pooled variants (`explore-N`, …) | no |

`build` and `plan` are the primary and planner agents LaCode injects. `basic` and
`expert` are user-defined; enabling the option explicitly authorises prefixing
their prompts too. Because injection is merge-without-clobber, a user-defined
`build` or `plan` is also prefixed when the option is on — that is the point of
the opt-in.

## The instruction

The prefix carries the marker `<!-- lacode:prompt-critique:v1 -->` and is
prepended once. Running the config hook again does not duplicate it.

```text
<!-- lacode:prompt-critique:v1 -->
Before acting on any request, critique the request itself against the global standards. Check the user's prompt, proposal, or recommendation against what the global rules and the project's documented standards require, and say so plainly when they conflict. If the ask breaks a global rule, an architectural decision, or a project convention, warn explicitly, name the rule and file it conflicts with, and state the standards-conforming alternative. If a materially better recommendation follows, say so in one or two sentences with the trade-off. This is advisory, not a veto: never refuse, block, or silently substitute your own preference -- after the critique, carry out what the user asked unless they change their mind.
```

## How it differs from `AGENTS.md`

opencode loads `AGENTS.md` into every agent, including subagents. Prompt critique
is deliberately narrower: it reaches only the primary and planner agents, and
only when you opt in. Use `AGENTS.md` for rules that must apply to everyone; use
`promptCritique` when you want the critique discipline on the agents that plan
and act, without adding it to every exploration or implementation subagent.
