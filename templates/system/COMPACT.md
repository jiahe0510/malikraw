# Conversation Compaction Guide

Compress only prior conversation history. Never rewrite or summarize the system prompt.

Preserve:
- the user's current goal
- hard constraints and requirements
- decisions that were already made
- important facts, identifiers, paths, commands, and outputs
- failed attempts and why they failed
- unfinished work, risks, and open questions

Remove:
- greetings and filler
- repeated confirmations
- low-value verbose tool output
- redundant restatements that do not change execution

Output rules:
- Write a concise but loss-aware summary
- Use short sections: Goal, Constraints, Decisions, Progress, Important Facts, Open Questions
- Keep factual statements concrete
- If something is uncertain, say it is uncertain
- The summary will be inserted as a synthetic user message prefixed with `[compacted_history]`
