# Voice and soul

## Write for a developer like you

Picture one developer sitting beside you. They are capable and busy. They do not need to be impressed, and they should not need prior knowledge of this package's vocabulary.

Help them build a useful mental model, get a result, and feel confident about the next step. Respect their intelligence without assuming they already understand the domain.

## Sound like a teammate

Be warm, direct, and genuinely interested in helping the reader succeed.

- Use `you` and natural contractions such as `you'll`, `don't`, and `isn't`.
- Start from the reader's situation: "You've got events arriving. Now you want code to handle them."
- Explain why a step matters before or immediately after asking the reader to do it.
- Celebrate progress through clarity: "You now have a channel feeding one handler." Do not manufacture excitement with slogans or repeated exclamation marks.
- Use short sentences when the idea is new. Let technical precision add detail only after the basic idea is clear.
- Give the reader credit. Do not say `simply`, `obviously`, `just`, or `easy` when the task may be unfamiliar.

Personality comes from attention to the reader, not jokes, hype, cuteness, or filler.

## Show the concrete thing first

Do not open with an inventory of internal responsibilities. Open with what the developer wants to accomplish.

Weak:

> Simple Agent Orchestrator connects an event source to your application code and keeps enough durable state to retry work safely.

Better:

> Imagine a reviewer leaves a comment on a pull request and you want a coding agent to handle it. The orchestrator saves that comment, sends it to your handler, and tries again if the handler fails.

Once the reader can picture the event, introduce the names `channel`, `delivery`, and `session` as useful labels for things they already understand.

## Say what the reader experiences

Prefer observable behavior over abstract system nouns.

| Avoid in guide prose | Prefer |
| --- | --- |
| durable state | saved state that is still there after a restart |
| durable ingestion | the event is saved before the request returns |
| normalized webhook | JSON already shaped like `DispatchEvent` |
| eligible delivery | work whose scheduled time has arrived |
| mutation | a command or method that changes saved data |
| ownership scope | the period when this runtime holds the state-file lock |
| coordination boundary | locks only work inside one running process |
| final persistence | saving the successful result |
| lifecycle hook | the function that starts, stops, creates, or cleans up the resource |
| reconciliation | check what already exists before creating or deleting anything |
| operation-specific idempotency key | a separate stable key for each outside action |

These terms are not banned. They may be the exact words a reference entry needs. In a guide, explain the concrete consequence first and use the formal term only when it helps the reader communicate or look up the API.

## Guides are journeys

A guide should move. The reader should always know what they are building, where they are, and what changed after the last step.

Good guide rhythm:

1. "We're going to build ..."
2. Show the command or code.
3. Explain the few choices that matter now.
4. Show what the reader should see.
5. Connect the result to the next step.

Use headings that describe progress: `Send the first event`, `Keep context between messages`, `Add retries`, `Run it continuously`.

Put advanced options under `Go further`, `When you need more control`, or a linked reference page. Do not make a beginner walk through config discovery, state versions, lock recovery, and HTTP limits before their first event works.

## Reference is a lookup tool

Reference material should be calmer and tighter than a guide. Personality should not slow down lookup.

- Organize by the product's domains and public import paths.
- Give every public API its own predictable heading.
- Put signatures before long behavior notes.
- Use tables for fields, defaults, status codes, and export inventories.
- Describe observable behavior precisely and neutrally.
- Link to guides for learning and examples rather than embedding another tutorial.
- Add direct member links when a page is too long to scan comfortably.

Friendly reference prose means clear wording, not conversational asides.

## Explain terms at first contact

Introduce each domain term with an everyday meaning:

> A delivery is the record of one handler processing one event. It tracks whether that work is waiting, running, processed, or failed.

Then use `delivery` normally. Do not repeatedly redefine it, and do not expect readers to infer its meaning from a type name.

When several terms fit together, follow one realistic example through them before presenting a summary table.

## Write useful cautions

Place a caution next to the action that creates the risk. State three things:

1. The condition.
2. What can happen.
3. What the developer should do.

Weak:

> Keep it on loopback while learning, and add project middleware before exposing it to a network. Stop the runtime before using CLI commands that mutate the default JSON state.

Better:

> The server does not authenticate requests. If other machines can reach it, add middleware that verifies every request before it can dispatch an event. When you use the default JSON store, stop `start` before running CLI commands that change the file; only one process can write it at a time.

Do not stack unrelated warnings into one dense paragraph. Keep the HTTP warning beside HTTP setup and the state-file warning beside commands that change state.

## Use examples as the explanation

Prefer one realistic, consistent example across a page. Give values names a developer can reason about: a pull request, review comment, branch, agent conversation, or worktree.

Before a code block, say what it demonstrates. After it, explain the important result rather than narrating every line.

Show expected output or an inspection command whenever it helps the reader confirm that the step worked.

Do not present fictional project functions as package APIs. Label them in prose or comments and explain what responsibility they represent.

## Keep prose breathable

- One main idea per paragraph.
- Prefer two clear paragraphs over one dense paragraph joined by semicolons.
- Use numbered steps only when order matters.
- Use bullets for parallel choices or rules.
- Use tables when readers compare fields or defaults.
- Break up a page before it becomes a wall of headings with equally dense text beneath each one.
- End guides with a small set of likely next steps.

Comprehensive does not mean saying everything on every page. It means the reader can find everything, at the moment they need it.

## Final read-aloud test

Before finishing, read each changed paragraph aloud.

Rewrite it if it sounds like:

- a system prompt;
- an architecture decision record pasted into a tutorial;
- a legal warning;
- marketing copy;
- a thesaurus replacement for a simpler sentence;
- something no developer would naturally say to another developer.

The target is a capable teammate saying: "Here's what we're building, here's how it works, and here's the one thing to watch out for."
