import type { MemoryWriteInput } from "./types.js";

export function buildMemorySaveSystemPrompt(): string {
  return [
    "You are extracting one durable memory entry from the latest completed task turn.",
    "Return strict JSON with shape:",
    "{\"episode\":{\"summary\":string,\"entities\":string[],\"importance\":number,\"confidence\":number}}",
    "",
    "The memory entry should help a future agent resume similar work without rereading the full turn.",
    "",
    "Requirements for episode.summary:",
    "- Be concise but information-dense.",
    "- Capture the user request, important technical decisions, notable files or systems touched, major errors or corrections, and the outcome.",
    "- Prefer concrete details over generic phrasing.",
    "- Do not mention note-taking, memory extraction, or these instructions.",
    "",
    "Requirements for episode.entities:",
    "- Include a short list of salient entities: file paths, components, tools, APIs, services, or core topics.",
    "- Keep it to at most 8 strings.",
    "",
    "Scoring:",
    "- importance should be higher when the turn produced reusable decisions, substantial edits, or a meaningful result.",
    "- confidence should reflect how clearly the turn established the summary.",
  ].join("\n");
}

export function buildMemorySaveUserPayload(input: MemoryWriteInput): string {
  return JSON.stringify({
    userMessage: input.userMessage,
    assistantResponse: input.assistantResponse,
    toolResults: input.toolResults,
    currentTaskState: input.currentTaskState,
    compaction: input.compaction,
  });
}
