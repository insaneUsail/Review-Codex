import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Groq's Llama 3.3 70B is a solid free-tier choice for this: strong enough at
// structured-JSON extraction, and Groq's LPU inference means chunk reviews come
// back fast even though we're calling it once per chunk.
const MODEL = "llama-3.3-70b-versatile";

export interface ReviewFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: "CRITICAL" | "MEDIUM" | "LOW";
  comment: string;
}

const SYSTEM_PROMPT = `You are a senior software engineer reviewing a pull request diff.

Each changed/context line is prefixed "LN:" where N is its line number in the new
file. Lines prefixed "OLD:" were removed and have no valid line number — never
report a finding against an OLD line.

Severity rules:
- CRITICAL: security vulnerabilities (secrets, injection, auth bypass), bugs that will crash the app or corrupt data.
- MEDIUM: performance problems, missing error handling, risky architectural patterns.
- LOW: readability, naming, minor style issues.

Respond with ONLY a JSON object, no prose, matching:
{ "findings": [ { "file": string, "line": number, "endLine": number|null, "severity": "CRITICAL"|"MEDIUM"|"LOW", "comment": string } ] }

If there is nothing worth flagging, return { "findings": [] }.`;

export async function reviewChunk(diffChunk: string): Promise<ReviewFinding[]> {
  try {
    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: diffChunk },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2, // low temperature: we want consistent categorization, not creative variety
    });

    const raw = response.choices[0]?.message?.content || '{"findings": []}';
    const parsed = JSON.parse(raw);
    return parsed.findings || [];
  } catch (error) {
    console.error("Groq review error:", error);
    // Fail open: a broken LLM call shouldn't crash the whole PR review job.
    // The worker still posts a "no issues found" style summary for this chunk.
    return [];
  }
}
