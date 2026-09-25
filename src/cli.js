// Single entry point for the packaged executable (AventraITSM.exe) and for scripts.
//   AventraITSM.exe                 start the server (default)
//   AventraITSM.exe setup [...]     first-run / upgrade setup for on-prem installs
//   AventraITSM.exe migrate | seed | check | version
// All app modules are imported lazily so `setup` can prepare DATABASE_URL before config loads.
const [cmd = 'start', ...rest] = process.argv.slice(2).filter((a, i, all) => !(i === 0 && a === process.argv[1]));

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

async function main() {
  const f = flags(rest);
  switch (cmd) {
    case 'start': {
      const { start } = await import('./server.js');
      await start();
      return;
    }
    case 'setup': {
      if (!f.dataDir || !f.pgBin) throw new Error('usage: setup --data-dir <dir> --pg-bin <postgres bin dir> [--port 8080] [--db-port 5433] [--host name] [--demo] [--no-service]');
      const { setup } = await import('./onprem/setup.js');
      await setup(f);
      return process.exit(0);
    }
    case 'stop-db': {
      const { stopDatabase } = await import('./onprem/setup.js');
      stopDatabase(f);
      return process.exit(0);
    }
    case 'migrate': {
      const { migrate } = await import('./db/migrate.js'); const { pool } = await import('./db/index.js');
      await migrate(); await pool.end(); return process.exit(0);
    }
    case 'seed': {
      const { seed } = await import('./db/seed.js'); const { pool } = await import('./db/index.js');
      await seed(); await pool.end(); return process.exit(0);
    }
    // Operator tool: comp a workspace (e.g. your own internal one), extend a trial, or reset to trial
    //   plan --workspace <slug> --status comped [--plan pro] [--seats 0]
    //   plan --workspace <slug> --extend-trial 14
    case 'plan': {
      if (!f.workspace) throw new Error('usage: plan --workspace <slug> [--status comped|trialing] [--plan starter|pro] [--seats N] [--extend-trial DAYS]');
      const { one: qOne, pool } = await import('./db/index.js');
      const sets = []; const vals = [f.workspace];
      if (f.status) { if (!['comped', 'trialing', 'active', 'canceled'].includes(f.status)) throw new Error('bad --status'); vals.push(f.status); sets.push(`billing_status=$${vals.length}`); }
      if (f.plan) { if (!['starter', 'pro'].includes(f.plan)) throw new Error('bad --plan'); vals.push(f.plan); sets.push(`billing_plan=$${vals.length}`); }
      if (f.seats !== undefined) { vals.push(parseInt(f.seats, 10)); sets.push(`seats=$${vals.length}`); }
      if (f.extendTrial) { vals.push(parseInt(f.extendTrial, 10)); sets.push(`trial_ends_at=GREATEST(trial_ends_at, now()) + ($${vals.length} || ' days')::interval, billing_status='trialing', trial_reminded_at=NULL`); }
      if (!sets.length) throw new Error('nothing to change');
      const t = await qOne(`UPDATE tenants SET ${sets.join(', ')} WHERE slug=$1 RETURNING slug, billing_plan, billing_status, seats, trial_ends_at`, vals);
      if (!t) throw new Error(`workspace "${f.workspace}" not found`);
      console.log(t); await pool.end(); return process.exit(0);
    }
    case 'check': {
      const { runCheck } = await import('../scripts/check-integrations.js');
      return runCheck(rest);
    }
    case 'version':
    case '--version':
      console.log(`Aventra ITSM ${process.env.ITSM_VERSION || '1.0.0'} (node ${process.version})`);
      return process.exit(0);
    default:
      console.error(`Unknown command "${cmd}". Commands: start, setup, migrate, seed, check, version`);
      process.exit(2);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
