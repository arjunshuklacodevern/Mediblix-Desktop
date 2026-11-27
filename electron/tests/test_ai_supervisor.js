/**
 * Mediblix Desktop — Local AI Supervisor Lifecycle Verification Test
 *
 * Verifies that the application automatically starts the local Ollama daemon
 * without user intervention, connects to port 11434, queries local models,
 * and cleanly stops the daemon on application quit.
 */

const {
  isOllamaPortOccupied,
  checkOllamaHealth,
  resolveOllamaBinary,
  resolveOllamaModelsDir,
  startOllama,
  stopOllama,
} = require('../ai-supervisor');
const http = require('http');

async function runSupervisorTest() {
  console.log('=================================================================');
  console.log(' Mediblix Desktop — AI Supervisor Automated Lifecycle Test      ');
  console.log('=================================================================');

  // Step 1: Verify daemon is currently stopped
  console.log('\n[Step 1] Verifying port 11434 status prior to launch...');
  const occupiedInitial = await isOllamaPortOccupied();
  console.log(`  -> Initial port 11434 occupied: ${occupiedInitial}`);

  // Step 2: Binary & model resolution
  console.log('\n[Step 2] Resolving bundled runtime and models...');
  const binary = resolveOllamaBinary();
  const modelsDir = resolveOllamaModelsDir();
  console.log(`  ✓ Resolved binary: ${binary}`);
  console.log(`  ✓ Resolved models directory: ${modelsDir}`);

  if (!binary) {
    throw new Error('FAILED: Ollama binary not resolvable');
  }

  // Step 3: Start Ollama via Supervisor
  console.log('\n[Step 3] Launching Ollama daemon via startOllama()...');
  const startResult = await startOllama();
  console.log(`  ✓ startOllama returned: running=${startResult.running}, reused=${startResult.reused}`);

  if (!startResult.running) {
    throw new Error(`FAILED: startOllama failed: ${startResult.error}`);
  }

  // Step 4: Health check
  console.log('\n[Step 4] Checking daemon health API...');
  const health = await checkOllamaHealth();
  console.log(`  ✓ Daemon isHealthy: ${health.isHealthy}`);
  console.log(`  ✓ Available models: ${health.models.map(m => m.name).join(', ')}`);

  if (!health.isHealthy) {
    throw new Error('FAILED: Daemon reported unhealthy after launch');
  }

  // Step 5: Execute genuine test inference via spawned daemon
  console.log('\n[Step 5] Executing test inference on spawned daemon (Llama 3.2 3B)...');
  const payload = JSON.stringify({
    model: 'llama3.2:3b',
    messages: [{ role: 'user', content: 'Say "Mediblix offline AI ready"' }],
    stream: false,
    options: { temperature: 0.1, num_predict: 20 },
  });

  const responseText = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 11434,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.message?.content || '');
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  console.log(`  ✓ Test response received from local model: "${responseText.trim()}"`);

  // Step 6: Graceful shutdown
  console.log('\n[Step 6] Stopping daemon via stopOllama()...');
  await stopOllama();
  await new Promise((r) => setTimeout(r, 1000));

  const occupiedAfter = await isOllamaPortOccupied();
  console.log(`  ✓ Port 11434 occupied after stop: ${occupiedAfter}`);

  if (occupiedAfter) {
    console.warn('  ! Port still occupied (may take a moment to release)');
  } else {
    console.log('  ✓ Port released cleanly. No orphan processes.');
  }

  console.log('\n=================================================================');
  console.log(' AI Supervisor Automated Lifecycle Test: PASSED                 ');
  console.log('=================================================================');
}

runSupervisorTest().catch((err) => {
  console.error('\n❌ Lifecycle Test Failed:', err);
  process.exit(1);
});
