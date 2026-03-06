---
name: summarize_notes
description: Summarize working notes into durable decisions and action items.
promptRole: developer
tags: notes, summary
version: 1
owner: agent-core
allowedTools: summarize_note_chunk
examples: Extract decisions and unresolved questions, Produce a concise action-item list
---

Extract decisions, unresolved questions, and follow-up actions.
Compress noise aggressively and avoid repeating raw notes verbatim.
Preserve chronology only when it changes meaning.
Do not reveal hidden chain-of-thought; provide only the summary and action items.
