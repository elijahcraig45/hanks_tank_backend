const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');

const repoRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(repoRoot, 'scripts', 'bigquery', 'transactions_schema.sql');
const nonInteractive = process.argv.includes('--non-interactive');
const skipInstall = process.argv.includes('--skip-install');
const skipCollect = process.argv.includes('--skip-collect');

function run(command, args, options = {}) {
  const baseOptions = {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  };
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], baseOptions)
    : spawnSync(command, args, baseOptions);

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function main() {
  if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
    throw new Error('Must be run from the hanks_tank_backend repository.');
  }

  console.log("MLB Transactions Setup");
  console.log("======================");
  console.log('');

  if (!skipInstall && !fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    console.log('Installing dependencies...');
    run('npm', ['install']);
  } else {
    console.log('Skipping dependency install.');
  }

  console.log('Building backend...');
  run('npm', ['run', 'build']);

  console.log('');
  console.log('Create the BigQuery table with this schema:');
  console.log('-------------------------------------------');
  console.log(fs.readFileSync(schemaPath, 'utf8').trim());
  console.log('-------------------------------------------');

  let shouldCollect = false;
  if (nonInteractive) {
    shouldCollect = !skipCollect;
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await rl.question('Press Enter once the BigQuery table exists...');
    const collectAnswer = await rl.question('Collect historical transactions now? (y/N): ');
    shouldCollect = /^y(es)?$/i.test(collectAnswer.trim());
    rl.close();
  }

  if (shouldCollect) {
    console.log('Collecting historical transactions...');
    run('node', ['scripts/collect_historical_transactions.js']);
  } else {
    console.log('Skipping historical transaction collection.');
  }

  console.log('');
  console.log('Next steps:');
  console.log('1. Start the backend with `npm run dev`.');
  console.log('2. Verify `/health` responds locally.');
  console.log('3. Verify transactions endpoints such as:');
  console.log('   - GET /api/transactions/recent');
  console.log('   - GET /api/transactions/year/:year');
  console.log('   - GET /api/transactions/team/:teamId');
  console.log('   - GET /api/transactions/player/:playerId');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
