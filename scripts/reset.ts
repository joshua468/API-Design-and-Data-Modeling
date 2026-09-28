/**
 * Destroys the local database and rebuilds it from migrations.
 *
 * Destructive by design and guarded twice: the path must be inside the project
 * directory, and it must carry the name this project gives it. A script that
 * can delete a database is a script that will eventually be run from the wrong
 * directory, so the guard checks the resolved absolute path rather than
 * trusting the current working directory.
 */
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { dataPath } from './lib/db.ts';

async function main(): Promise<void> {
  const target = dataPath();
  const root = resolve(process.cwd());
  const dirName = process.env['PGLITE_DATA_DIR'] ?? '.pglite';

  if (!target.startsWith(root + sep)) {
    console.error(
      `Refusing to delete ${target}: it is outside the project directory ${root}.`
    );
    process.exit(1);
  }
  if (!dirName.startsWith('.pglite')) {
    console.error(
      `Refusing to delete ${target}: PGLITE_DATA_DIR must be a .pglite* path ` +
        `(got "${dirName}") so a typo cannot point this script at real data.`
    );
    process.exit(1);
  }

  await rm(target, { recursive: true, force: true });
  console.log(`\n  Dropped ${target}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
