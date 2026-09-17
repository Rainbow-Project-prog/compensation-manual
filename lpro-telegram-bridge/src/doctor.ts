/**
 * 起動前の事前チェック CLI（`npm run doctor`。`npm start` の prestart でも自動実行）。
 * チェック本体は preflight.ts（index.ts の起動時ガードと共通）。
 */
import { runDoctor, printResult } from './preflight.js';

const result = runDoctor();
printResult(result);
if (result.problems.length > 0) process.exit(1);
