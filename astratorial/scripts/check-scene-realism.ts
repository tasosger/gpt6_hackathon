/** Re-render a saved plan/illustration locally without API calls or uploads. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TutorialPlanSchema } from "../lib/contracts";
import { buildIllustratedScene, exportGlb } from "../lib/local/scene";
import { renderIllustration } from "../lib/local/render";

async function main() {
  const source = resolve(process.argv[2] || "../outputs/local-ai");
  const destination = resolve(process.argv[3] || "../outputs/realism-after");
  if (source === destination) throw new Error("Use a separate output directory to preserve the source.");
  const plan = TutorialPlanSchema.parse(JSON.parse(await readFile(resolve(source, "plan.json"), "utf8")));
  const illustration = JSON.parse(await readFile(resolve(source, "illustration.json"), "utf8"));
  const built = buildIllustratedScene(plan, illustration);
  await mkdir(destination, { recursive: true });
  const file = resolve(destination, "scene.glb");
  const bytes = await exportGlb(built.scene, built.clip);
  await writeFile(file, bytes);
  await writeFile(resolve(destination, "manifest.json"), JSON.stringify(built.manifest, null, 2));
  const rendered = await renderIllustration(file, built.manifest, destination, false);
  console.log({ ...rendered, glbBytes: bytes.length, objects: built.manifest.objects.length });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
