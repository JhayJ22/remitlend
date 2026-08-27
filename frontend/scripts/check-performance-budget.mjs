import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const budgetBytes = Number(process.env.NEXT_PERFORMANCE_BUDGET_BYTES ?? 2_000_000);
const chunksDirectory = "./.next/static/chunks";

async function getJavaScriptBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return getJavaScriptBytes(path);
      if (!entry.name.endsWith(".js")) return 0;
      return (await stat(path)).size;
    }),
  );
  return sizes.flat(Infinity).reduce((total, size) => total + size, 0);
}

try {
  const bytes = await getJavaScriptBytes(chunksDirectory);
  if (bytes > budgetBytes) {
    console.error(`Performance budget exceeded: ${bytes} bytes > ${budgetBytes} bytes`);
    process.exit(1);
  }
  console.log(`Performance budget passed: ${bytes} bytes <= ${budgetBytes} bytes`);
} catch (error) {
  console.error("Performance budget could not inspect the production build", error);
  process.exit(1);
}
