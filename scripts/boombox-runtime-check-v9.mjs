import { ensureConverterReady } from '../src/services/boomboxConversionService.js';

console.log('SKAW BOOMBOX v9 runtime check');
console.log(`Node: ${process.version}`);
console.log(`Platform: ${process.platform}/${process.arch}`);
try {
  const ready = await ensureConverterReady({ checkTop4Top: true });
  console.log('PASS: converter engine is ready');
  console.log(JSON.stringify(ready, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error('FAIL: converter engine is not ready');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
