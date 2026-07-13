# Core concepts

The easiest way to understand the package is to follow one piece of work from start to finish. Imagine your project watches a GitHub repository. A reviewer leaves a comment on a pull request, and you want a coding agent to respond.

```text
GitHub comment -> channel -> event -> delivery -> handler
                                  |
                                  +-> pull request session
```

## 1. The channel brings the comment in

A **channel** represents one source of events. In this example, the channel might poll GitHub for new review comments. It turns each comment into the package's event shape and dispatches it.

The **event** is the saved record of that comment. Your application chooses its ID, input, and two keys that answer important questions:

| Field | Question it answers | Default |
| --- | --- | --- |
| `id` | What does GitHub call this item? | Required |
| `dedupeKey` | Have we already accepted this version of the comment? | `id` |
| `sessionKey` | Which larger piece of work does it belong to? | `${channelId}:${id}` |

For a review comment, you could use a different deduplication key for each revision while sending every comment on the pull request to the same session:

```ts
{
  id: review.id,
  dedupeKey: `${review.id}:${review.updatedAt}`,
  sessionKey: `github:${review.owner}/${review.repo}:pr:${review.number}`,
  input: review.body,
}
```

The package checks duplicates using the channel ID plus `dedupeKey`. If the same logical event arrives again, dispatch returns the original internal event ID and doesn't create more work for handlers.

## 2. The client decides what to do

A **client** groups the code and settings for one consumer of events. It subscribes a **handler** to the GitHub channel. That handler might load the pull request, ask a coding agent to make a change, and post a reply.

When dispatch accepts the comment, it first saves the event and creates a **delivery** for each matching handler. A delivery is simply that handler's processing record: whether it's waiting, running, processed, or failed, and how many attempts it has made.

Dispatch returns after the event and deliveries are saved. A handler may still be waiting or running, so an accepted event isn't the same as completed work.

## 3. The session carries the pull request context

A **session** gives related events a shared place for state and notes. Because all comments on this pull request use the same `sessionKey`, the handler can continue one agent conversation, remember earlier decisions, or reuse the same worktree.

When a handler ends the session, its history remains available. The next event with that key starts a new active session rather than reopening the old one.

## 4. Environments provide the tools

An **environment** holds resources that a client can reuse while the process is running, such as a GitHub API client or a local agent server. It can also manage a **sandbox**, a resource tied to one session. For this pull request, the sandbox could save a typed description of a dedicated Git worktree so the handler and cleanup use the same resource after retries or restarts.

The handler receives the event, session, environment, typed sandbox accessor, logger, and an `AbortSignal` it can pass to APIs that support cancellation.

## 5. The runtime records the result

The **runtime** is the running orchestrator process. It starts polls, runs handlers, manages environments, and uses a **store** to save events, deliveries, sessions, notes, and poll positions.

If the handler succeeds, the runtime saves its session changes and marks the delivery `processed`. If it fails, the runtime records the error and either retries it using the handler's settings or marks it `failed`.

One event can produce several deliveries when multiple clients subscribe to the channel, or when one client registers several handlers. Each delivery succeeds, retries, or fails independently. There isn't an event-wide success hook that waits for all of them.

## What retries mean for your code

A handler can run more than once after an error, timeout, restart, or an interruption while its result is being saved. Make calls to outside systems safe to repeat by using stable idempotency keys or checking their current state first. Pass the handler's `signal` to APIs that support cancellation. The [failure guide](guides/failure-semantics.md) explains each step of an attempt.

Typed sandbox cleanup can save progress for named cleanup steps. That is a narrow cleanup feature, not an exactly-once guarantee or a workflow engine for general application work.

Concurrency limits and locks work only inside one runtime process. The default JSON store prevents a second runtime from actively using the same state file. If several processes need to share work, this package isn't the shared queue between them; use a system built for that job.

## The pieces at a glance

| Piece | Everyday meaning |
| --- | --- |
| **Project** | Your existing repository, including the code that calls source APIs, agents, and other services. |
| **Channel** | One way events enter, such as a poll or HTTP route. |
| **Event** | One saved item from a source. |
| **Client** | A consumer that subscribes handlers and chooses processing settings. |
| **Handler** | Your application code for one subscription. |
| **Delivery** | One handler's processing record for one event. |
| **Session** | Shared context for related events, such as one conversation or pull request. |
| **Environment** | Resources available to a client while the process runs. |
| **Sandbox** | A resource for one session, such as a worktree. |
| **Store** | Where events, attempts, sessions, notes, and poll positions are saved. |
| **Runtime** | The process that polls, dispatches, runs handlers, and manages resources. |

## Next steps

- [Build your first workflow](guides/getting-started.md).
- [Receive events with channels](guides/channels.md).
- [Process events with clients](guides/clients.md).
