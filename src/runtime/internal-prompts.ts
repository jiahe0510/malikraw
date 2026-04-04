export const BUILT_IN_MEMORY_GUIDANCE = [
  "Memory Usage Guidance",
  "",
  "Use stored memory as supporting context, not as unquestionable truth.",
  "- Prefer recent conversation state over recalled memory when they conflict.",
  "- Treat retrieved memory as reusable prior work: previous user intents, durable preferences, earlier decisions, and successful tool chains.",
  "- If the user asks to ignore memory, do not rely on retrieved memory for that turn.",
  "- If a memory entry looks stale, partial, or irrelevant to the current request, ignore it.",
  "- Use memory to continue work more efficiently, but do not mention memory unless it helps the user.",
].join("\n");

const NO_TOOLS_PREAMBLE = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "- Do NOT use any tool.",
  "- You already have all the context you need in the conversation provided for compaction.",
  "- Tool calls will be rejected and waste the turn.",
  "- Your response must be plain text only.",
  "",
].join("\n");

const COMPACTION_ANALYSIS_INSTRUCTION = [
  "Before writing the final summary, internally reason through the conversation chronologically and ensure you cover:",
  "1. The user's explicit requests and changing intent.",
  "2. Technical decisions, file paths, code areas, and important commands.",
  "3. Errors, failed approaches, and user corrections.",
  "4. What was completed, what remains pending, and what the latest active work is.",
].join("\n");

export function buildBuiltInCompactionPrompt(extraInstructions?: string): string {
  const sections = [
    NO_TOOLS_PREAMBLE,
    "Your task is to create a detailed, loss-aware summary of the conversation history being compacted.",
    "The summary must preserve the working context needed to continue the task without re-reading the dropped messages.",
    "",
    COMPACTION_ANALYSIS_INSTRUCTION,
    "",
    "Write the final summary with these sections:",
    "1. Primary Request and Intent",
    "2. Key Technical Concepts",
    "3. Files, Code, and Commands",
    "4. Errors and Corrections",
    "5. Problem Solving Progress",
    "6. Pending Tasks",
    "7. Current Work",
    "8. Next Step",
    "",
    "Requirements:",
    "- Be concrete and information-dense.",
    "- Preserve exact file paths, API names, tool names, and command names when they matter.",
    "- Include the user's latest corrections or constraints explicitly.",
    "- Focus on continuity for ongoing implementation work, not conversational filler.",
    "- Do not summarize the system prompt itself.",
  ];

  if (extraInstructions?.trim()) {
    sections.push("", "Additional compaction instructions:", extraInstructions.trim());
  }

  return sections.join("\n");
}
