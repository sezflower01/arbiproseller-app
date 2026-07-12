// Zips extension/ and extension-create/ into public/*.zip so the admin
// "Download .zip" buttons (see src/config/moduleCategories.ts downloadUrl)
// always ship whatever is currently in those source folders. Runs as part of
// `npm run build`, before `vite build` copies public/ into dist/. The output
// files are gitignored (public/*.zip) -- they're build artifacts, regenerated
// fresh on every build, never committed.
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { ZipArchive } from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function zipDir(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

async function main() {
  const targets = [
    {
      src: path.join(root, "extension"),
      out: path.join(root, "public", "arbiproseller-extension.zip"),
    },
    {
      src: path.join(root, "extension-create"),
      out: path.join(root, "public", "arbiproseller-create-listing-extension.zip"),
    },
  ];

  await mkdir(path.join(root, "public"), { recursive: true });

  for (const { src, out } of targets) {
    await zipDir(src, out);
    console.log(`Built ${path.relative(root, out)} from ${path.relative(root, src)}/`);
  }
}

main().catch((err) => {
  console.error("Failed to build extension zips:", err);
  process.exit(1);
});
