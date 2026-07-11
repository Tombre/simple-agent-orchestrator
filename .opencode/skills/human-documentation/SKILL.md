---
name: human-documentation
description: Documentation writing and review for READMEs, guides, tutorials, concepts, examples, CLI docs, and API references. Use whenever creating, rewriting, reviewing, or organizing human-facing developer documentation.
---

# Human documentation

Write as a **teammate**: an experienced developer helping another developer get something working. The reader is intelligent, but may know nothing about this package or its domain.

Before drafting or reviewing documentation, read [VOICE.md](VOICE.md). It defines the required voice, the difference between guides and reference material, and the language patterns to avoid.

## Process

### 1. Name the reader's job

Write one sentence that completes this prompt:

> After reading this page, the developer can ...

If the page has several unrelated answers, split it or choose one as the main journey. This step is complete when the page has one clear primary job.

### 2. Choose the document mode

Classify the page before outlining it:

| Mode | Reader need | Shape |
| --- | --- | --- |
| Tutorial | "Help me learn by building something" | One complete, reliable journey |
| How-to guide | "Help me accomplish this task" | The shortest useful path, then options |
| Explanation | "Help me understand how this fits together" | A concrete story, then the general model |
| Reference | "Tell me exactly what is available" | Scannable facts grouped by domain |

Do not blend modes accidentally. Link to another page rather than interrupting a walkthrough with a complete specification.

### 3. Verify the product before explaining it

Read the implementation, tests, templates, CLI help, existing contracts, and related documentation that cover the topic. Check the documentation index and nearby pages before deciding where new information belongs. Identify the canonical page for the topic so the same explanation does not spread across several files.

Identify defaults, failure behavior, return values, security responsibilities, and limitations that affect the reader.

This step is complete when every behavioral claim and runnable example can be traced to the current product.

### 4. Outline the reader's path

For a tutorial or how-to guide, order sections around the developer's progress:

1. What they are about to build or accomplish.
2. What they need before starting.
3. The smallest useful first step.
4. What happened and why it matters.
5. The next useful capability.
6. Risks or alternatives placed next to the choice that creates them.
7. A visible result they can verify.
8. Links to likely next tasks.

For explanation, follow one realistic example through the system before naming the general model.

For reference, group APIs by domain. Give each public symbol a stable heading and signature, then document its purpose, parameters or fields, defaults, return value, errors, and important side effects when they apply. Add a contents list or member index when the page is long.

This step is complete when a reader can scan the headings and predict the journey or find the API they need.

### 5. Draft in teammate voice

Apply every rule in [VOICE.md](VOICE.md).

Lead with what the developer wants, not what the implementation owns. Introduce a technical term only after giving it an everyday meaning or showing it in a real example. Prefer concrete outcomes such as "saved before dispatch returns" over abstract labels such as "durable ingestion."

This step is complete when each paragraph answers a question the reader is likely to have at that point.

### 6. Make examples teach one thing at a time

Use the smallest example that produces a useful result. Introduce it with what it demonstrates, then explain the important lines and show how to verify the outcome.

Mark project-provided functions clearly. Do not hide prerequisites, security checks, cleanup, or retry requirements behind unexplained placeholders.

This step is complete when examples are accurate, focused, and runnable or clearly labeled as partial.

### 7. Edit from the reader's chair

Read the page in order as if you had never seen the package.

Remove:

- terms introduced before their meaning;
- implementation detail that arrives before its practical consequence;
- repeated cautions already explained on a better page;
- walls of prose that should be steps, tables, or separate sections;
- throat-clearing, marketing filler, and sentences that merely restate a heading;
- dry phrases called out in [VOICE.md](VOICE.md).

Check every link and heading anchor. Run or type-check examples where practical.

The work is complete only when the common path is understandable without reading advanced sections, every risky action has nearby guidance, every factual claim matches the product, and the page sounds like a helpful developer rather than generated documentation.
