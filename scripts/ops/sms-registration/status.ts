import { statusMain } from './cli';

export const main = (
  args: readonly string[],
  baseDirectory = import.meta.dir,
): Promise<number> => statusMain(args, baseDirectory);

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
