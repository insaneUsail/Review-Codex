import { getEncoding } from "js-tiktoken";
import type { File } from "parse-diff";

const encoding = getEncoding("cl100k_base");

// Token budget per chunk sent to the LLM. Kept conservative so a single chunk
// plus the system prompt comfortably fits in a fast/cheap Groq context window.
const TOKEN_BUDGET = 2500;

export interface DiffChunk {
  filePaths: string[];
  content: string;
  tokenCount: number;
}

/**
 * Turns a parsed diff (array of files, each with hunks/changes) into a list of
 * chunks to send to the LLM, one API call per chunk.
 *
 * Design rule: a chunk never contains a *partial* file — either a whole file's
 * hunks are in this chunk, or none of them are. This matters because a diff
 * hunk normally carries a few lines of surrounding context, but a large file
 * with many separate hunks could still get its hunks split across two model
 * calls under a naive "keep packing until full" approach. Forcing whole-file
 * grouping means the model always sees everything that changed in a file
 * together, so it can reason about relationships between two hunks in the
 * same file (e.g. a function definition changed in one hunk, its only call
 * site changed in another).
 *
 * Trade-off: a single file whose diff exceeds the token budget on its own still
 * gets sent as an oversized chunk rather than being split — accepted here
 * because splitting a file's own hunks defeats the point above. In practice
 * this only happens on very large generated diffs, which MAX_DIFF_SIZE_BYTES
 * already filters out upstream.
 */
export function chunkDiff(files: File[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let currentContent = "";
  let currentFiles: string[] = [];
  let currentTokens = 0;

  for (const file of files) {
    const filePath = file.to && file.to !== "/dev/null" ? file.to : file.from || "unknown";
    const fileText = renderFile(filePath, file);
    const fileTokens = encoding.encode(fileText).length;

    const wouldOverflow = currentTokens + fileTokens > TOKEN_BUDGET && currentContent !== "";

    if (wouldOverflow) {
      chunks.push({ filePaths: currentFiles, content: currentContent, tokenCount: currentTokens });
      currentContent = fileText;
      currentFiles = [filePath];
      currentTokens = fileTokens;
    } else {
      currentContent += fileText;
      currentFiles.push(filePath);
      currentTokens += fileTokens;
    }
  }

  if (currentContent.trim()) {
    chunks.push({ filePaths: currentFiles, content: currentContent, tokenCount: currentTokens });
  }

  return chunks;
}

/**
 * Renders one file's hunks with absolute line numbers prefixed (LN: ...),
 * so the model can report a line number we can trust when posting inline
 * review comments back to GitHub. Deleted lines are marked OLD and don't
 * get a line number, since they don't exist in the new file version.
 */
function renderFile(filePath: string, file: File): string {
  let out = `\n--- File: ${filePath} ---\n`;

  for (const hunk of file.chunks) {
    let newLine = hunk.newStart;
    for (const change of hunk.changes) {
      if (change.type === "add" || change.type === "normal") {
        out += `L${newLine}: ${change.content}\n`;
        newLine++;
      } else if (change.type === "del") {
        out += `OLD: ${change.content}\n`;
      }
    }
  }

  return out;
}
