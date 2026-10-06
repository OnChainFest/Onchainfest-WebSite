import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const copies = [
  ["index.html", "public/home.html"],
  ["contact.html", "public/contact.html"],
  ["favicon.ico", "public/favicon.ico"],
  ["logo.png", "public/logo.png"],
  ["img", "public/img"],
];

for (const [from, to] of copies) {
  const target = join(root, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, from), target, { recursive: true, force: true });
}

console.log("[onchainfest] static landing assets prepared");
