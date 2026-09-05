// One-shot worker: open the DB in this thread, write data.json, post the summary.
import { extractToFile } from "./index.ts";

addEventListener("message", (event: MessageEvent<{ out?: string }>) => {
  try {
    const out = event.data?.out;
    if (!out) throw new Error("missing out path");
    const summary = extractToFile(out);
    postMessage({ ok: true, summary });
  } catch (err) {
    postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
