/** Export the actual Zod contracts, never maintain a second hand-written wire schema. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { toJSONSchema } from 'zod';
import * as contracts from '../lib/contracts.ts';

const directory = fileURLToPath(new URL('../worker/contracts/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const name of ['TutorialPlanSchema', 'SceneManifestSchema', 'GenerationJobSchema', 'TutorialSchema']) {
  const schema = toJSONSchema(contracts[name], { target: 'draft-2020-12', io: 'output' });
  await writeFile(`${directory}${name.replace('Schema', '')}.json`, `${JSON.stringify(schema, null, 2)}\n`);
}
console.log('Exported 4 shared worker contracts.');
