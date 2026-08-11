import { dropStartFlowPlaywrightDatabase } from './playwright-database';

export default async function removeStartFlowPlaywrightDatabase(): Promise<void> {
  await dropStartFlowPlaywrightDatabase();
}
