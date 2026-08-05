import { readFileSync } from "fs";
import { selectContext } from "../chatbot-worker/src/retrieve.js";

const { chunks } = JSON.parse(readFileSync(new URL("../kb/kb-index.json", import.meta.url)));

const questions = [
  "What did he do at OYO?",
  "Tell me about the Priority Leads Tool",
  "What is Ship Gate?",
  "How does the arthritis app screen for inflammation?",
  "What's his email?",
  "Has he managed a team before?",
  "What did he study in college?",
  "Tell me about Assisted Selling and Search Explorer",
];

for (const q of questions) {
  const { canonical, retrieved } = selectContext(chunks, q);
  console.log(`\nQ: ${q}`);
  console.log(`  canonical: ${canonical.length} chunks (always included)`);
  console.log(`  retrieved top ${retrieved.length}:`);
  for (const c of retrieved.slice(0, 4)) {
    console.log(`    [${c.source}] ${c.headingPath} :: ${c.text.slice(0, 70)}...`);
  }
}
