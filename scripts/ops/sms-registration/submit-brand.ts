import { submitMain } from './cli';

export const main = (
  args: readonly string[],
  baseDirectory = import.meta.dir,
): Promise<number> => submitMain('brand', args, baseDirectory);

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
