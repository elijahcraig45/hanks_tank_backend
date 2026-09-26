/**
 * Unified predictions: every model's pregame prediction for one slate, one shape for
 * every sport.
 *
 *   GET /api/predictions/:sport/slate     sport = mlb | nfl | cfb
 *       mlb:       ?date=YYYY-MM-DD        (default today, America/New_York)
 *       football:  ?season=&week=          (default the current week)
 *       cfb:       &division=fbs|fcs|all   (default fbs, like the Models page)
 *   GET /api/predictions/:sport/players   ?date= | ?game_id=   (MLB only)
 *   Either takes ?format=csv (long-format export) or ?format=json (bare data).
 *
 * Contract: scratchpad predictions_contract.md (v1, 2026-09-25). The rules that matter:
 *   - Per game and model, the latest row written strictly before the start; if none, the
 *     latest row, flagged pregame:false (pickPrediction / pickLatestPregameRow — the same
 *     code as /api/models/:sport/compare, so the MLB backfill rows never masquerade as
 *     pregame).
 *   - Every registry model appears in models[] and in every game's predictions (null when
 *     it has no row). A table that does not exist yet is available:false, not a 500.
 *   - Models, tables and their SQL come from config/models.config (the model registry)
 *     and modelSql in models.controller; nothing about a model is re-declared here.
 *
 * All queries are parameterized. The built data is cached in cache.service: 5 minutes
 * for today and upcoming slates, 1 hour once a slate is entirely in the past.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { mlbApi } from '../services/mlb-api.service';
import { cacheService } from '../services/cache.service';
import { getCacheKey } from '../utils/cache-keys';
import { getFootballSport, FootballSportConfig } from '../config/football.config';
import { MLB_DATASET, ModelSource, modelsForSport } from '../config/models.config';
import { isMissingTable } from '../utils/football-request';
import {
  ModelRow, SpineRow, defaultWeek, marketProbability, pickPrediction, pickLatestPregameRow,
} from '../utils/football-compare';
import { spineSql } from './football-compare.controller';
import { modelSql } from './models.controller';
import {
  PLAYER_CSV_HEADERS, SLATE_CSV_HEADERS, SimDistRow, SlatePrediction, buildPrediction,
  consensusOf, disagreementLevel, exportFilename, finite, meanDist, normalizePlayerRow,
  pickDist, slateCsvRows, slateTtl, toCsv, toIso,
} from '../utils/unified-slate';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });
const table = (dataset: string, name: string) => `\`${PROJECT}.${dataset}.${name}\``;

export const SIM_DIST_TABLE = 'game_sim_distributions';
export const PLAYER_PROJ_TABLE = 'player_sim_projections';
/** Largest built slate kept in the per-instance Map (it has no size bound or LRU). */
const MAX_CACHED_BYTES = 1024 * 1024;
/** A football game with no result this long after kickoff is no longer "live". */
const LIVE_WINDOW_MS = 6 * 3600 * 1000;

export const RULE = 'Per game and model: the latest prediction written strictly before '
  + 'the start. A game whose only prediction was written after the start shows it '
  + 'flagged pregame:false. A model with no row for a game is null; a model whose table '
  + 'does not exist is available:false. Consensus and disagreement use pregame '
  + 'predictions of available models only.';

type Format = 'envelope' | 'json' | 'csv';

const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

interface ModelEntry {
  key: string;
  label: string;
  role: string;
  available: boolean;
  outputs: string[];
  learn: string | null;
  rows: number;
  note: string | null;
}

/* ── query helpers ───────────────────────────────────────────────────── */

/** Run a query; a table or column that does not exist comes back as `missing`. */
async function safeQuery(
  query: string, params: Record<string, any>, types?: Record<string, any>,
): Promise<{ rows: any[]; missing: boolean; reason?: string }> {
  try {
    const [rows] = await bigquery.query({ query, params, ...(types ? { types } : {}) });
    return { rows: rows as any[], missing: false };
  } catch (error: any) {
    if (!isMissingTable(error)) throw error;
    logger.warn('unified slate: source unavailable', { error: error.message });
    return { rows: [], missing: true, reason: error.message };
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
}

function entryFor(m: ModelSource, loaded: { rows: any[]; missing: boolean } | null,
  datasetName: string, simMissing?: boolean): ModelEntry {
  const base = {
    key: m.key,
    label: m.label,
    role: m.role,
    outputs: m.outputs || ['win_prob'],
    learn: m.learn ?? null,
  };
  if (!m.table || !loaded) {
    return { ...base, available: false, rows: 0, note: m.note || 'No live source for this model.' };
  }
  if (loaded.missing && (simMissing ?? true)) {
    return {
      ...base, available: false, rows: 0,
      note: `Not live yet: ${datasetName}.${m.table} has not been created.`,
    };
  }
  return {
    ...base,
    available: true,
    rows: loaded.rows.length,
    note: loaded.rows.length ? null : 'No predictions for this slate yet.',
  };
}

/** Attach consensus and disagreement to an assembled game. */
function finishGame(game: any, available: Set<string>) {
  const consensus = consensusOf(game.predictions, available);
  return { ...game, consensus, disagreement: disagreementLevel(consensus.spread) };
}

/* ── MLB ─────────────────────────────────────────────────────────────── */

/**
 * The BigQuery half of the MLB spine for one date: every game with a prediction row or
 * a games row (games inserts rather than upserts, hence the GROUP BY), with abbreviations
 * from teams. The MLB Stats API schedule is layered on top for status, live scores and
 * games nothing has predicted yet.
 */
export function mlbSlateSpineSql(): string {
  return `
    WITH p AS (
      SELECT game_pk,
             ANY_VALUE(home_team_id) AS home_team_id, ANY_VALUE(away_team_id) AS away_team_id,
             ANY_VALUE(home_team_name) AS home_team_name,
             ANY_VALUE(away_team_name) AS away_team_name,
             MAX(game_time_utc) AS game_time_utc
      FROM ${table(MLB_DATASET, 'game_predictions')}
      WHERE game_date = @date
      GROUP BY game_pk
    ),
    g AS (
      SELECT game_pk,
             ANY_VALUE(home_team_id) AS home_team_id, ANY_VALUE(away_team_id) AS away_team_id,
             ANY_VALUE(home_team_name) AS home_team_name,
             ANY_VALUE(away_team_name) AS away_team_name,
             MAX(home_score) AS home_score, MAX(away_score) AS away_score,
             LOGICAL_OR(status IN ('Final', 'Game Over', 'Completed Early')
                        OR STARTS_WITH(status, 'Final')) AS final,
             ANY_VALUE(status) AS status
      FROM ${table(MLB_DATASET, 'games')}
      WHERE game_date = @date
      GROUP BY game_pk
    ),
    t AS (
      SELECT team_id, ANY_VALUE(team_code) AS team_code
      FROM ${table(MLB_DATASET, 'teams')}
      GROUP BY team_id
    )
    SELECT game_pk,
           COALESCE(p.home_team_id, g.home_team_id) AS home_team_id,
           COALESCE(p.away_team_id, g.away_team_id) AS away_team_id,
           COALESCE(p.home_team_name, g.home_team_name) AS home_team_name,
           COALESCE(p.away_team_name, g.away_team_name) AS away_team_name,
           th.team_code AS home_abbr, ta.team_code AS away_abbr,
           p.game_time_utc, g.home_score, g.away_score, g.final, g.status
    FROM p FULL OUTER JOIN g USING (game_pk)
    LEFT JOIN t th ON th.team_id = COALESCE(p.home_team_id, g.home_team_id)
    LEFT JOIN t ta ON ta.team_id = COALESCE(p.away_team_id, g.away_team_id)`;
}

export const simDistSql = (dataset: string) => `
    SELECT * FROM ${table(dataset, SIM_DIST_TABLE)}
    WHERE CAST(game_date AS DATE) BETWEEN @from AND @to`;

// Dates go in as plain strings, which BigQuery coerces against a DATE column. Declaring
// types: { date: 'DATE' } on a string value silently matched nothing (measured: 0 rows vs
// 25) with this client version, so it is deliberately not done.
const DATE_TYPES = undefined;
const RANGE_TYPES = undefined;

interface SpineGame {
  game_id: string;
  start_time: string | null;
  status: 'scheduled' | 'live' | 'final';
  status_detail: string | null;
  home: { id: string | null; name: string | null; abbr: string | null };
  away: { id: string | null; name: string | null; abbr: string | null };
  result: { home_score: number | null; away_score: number | null };
  /** Also match sim rows keyed by this id (NFL game_pk). */
  alt_id?: string | null;
}

const team = (id: any, name: any, abbr: any) => ({
  id: id == null ? null : String(id), name: name ?? null, abbr: abbr ?? null,
});

function apiStatus(g: any): 'scheduled' | 'live' | 'final' {
  const s = g?.status?.abstractGameState;
  if (s === 'Live') return 'live';
  if (s === 'Final') {
    // A postponed or cancelled game is "Final" to the API but was never played.
    const d = String(g?.status?.detailedState || '');
    return /postponed|cancel/i.test(d) ? 'scheduled' : 'final';
  }
  return 'scheduled';
}

/** Merge the BigQuery spine and the MLB API schedule into one list of games. */
export function mergeMlbSpine(bqRows: any[], schedule: any | null, nowMs = Date.now()): SpineGame[] {
  const out = new Map<string, SpineGame>();
  for (const r of bqRows) {
    const id = String(r.game_pk);
    const start = toIso(r.game_time_utc);
    const hs = finite(r.home_score);
    const as = finite(r.away_score);
    const final = Boolean(r.final) && hs != null && as != null;
    const started = start != null && Date.parse(start) <= nowMs;
    out.set(id, {
      game_id: id,
      start_time: start,
      status: final ? 'final' : (started ? 'live' : 'scheduled'),
      status_detail: r.status ?? null,
      home: team(r.home_team_id, r.home_team_name, r.home_abbr),
      away: team(r.away_team_id, r.away_team_name, r.away_abbr),
      result: { home_score: final ? hs : null, away_score: final ? as : null },
    });
  }
  const skip = new Set(['S', 'E', 'A']); // spring training, exhibition, all-star
  for (const d of schedule?.dates || []) {
    for (const g of d.games || []) {
      if (skip.has(g.gameType)) continue;
      const id = String(g.gamePk);
      const prev = out.get(id);
      const h = g.teams?.home;
      const a = g.teams?.away;
      const status = apiStatus(g);
      out.set(id, {
        game_id: id,
        start_time: toIso(g.gameDate) ?? prev?.start_time ?? null,
        status,
        status_detail: g.status?.detailedState ?? prev?.status_detail ?? null,
        home: team(h?.team?.id ?? prev?.home.id, h?.team?.name ?? prev?.home.name,
          h?.team?.abbreviation ?? prev?.home.abbr),
        away: team(a?.team?.id ?? prev?.away.id, a?.team?.name ?? prev?.away.name,
          a?.team?.abbreviation ?? prev?.away.abbr),
        result: status === 'scheduled'
          ? { home_score: null, away_score: null }
          : { home_score: finite(h?.score) ?? prev?.result.home_score ?? null,
            away_score: finite(a?.score) ?? prev?.result.away_score ?? null },
      });
    }
  }
  return [...out.values()].sort((x, y) => (x.start_time || '').localeCompare(y.start_time || '')
    || x.game_id.localeCompare(y.game_id));
}

async function buildMlbSlate(date: string) {
  const models = modelsForSport('mlb') as ModelSource[];
  const season = Number(date.slice(0, 4));
  const dateParams = { date };
  const withTable = models.filter((m) => m.table);

  const [spine, schedule, sims, players, ...loaded] = await Promise.all([
    safeQuery(mlbSlateSpineSql(), dateParams, DATE_TYPES),
    mlbApi.getScheduleWithOptions({ date, hydrate: 'team', cacheTtl: 120 })
      .catch((error: any) => {
        logger.warn('unified slate: MLB schedule unavailable', { date, error: error?.message });
        return null;
      }),
    safeQuery(simDistSql(MLB_DATASET), { from: date, to: date }, RANGE_TYPES),
    safeQuery(`
      SELECT DISTINCT CAST(game_pk AS STRING) AS game_id
      FROM ${table(MLB_DATASET, PLAYER_PROJ_TABLE)}
      WHERE CAST(game_date AS DATE) = @date`, dateParams, DATE_TYPES),
    ...withTable.map((m) => safeQuery(modelSql('mlb', m, MLB_DATASET, 'date', true), dateParams, DATE_TYPES)),
  ]);

  const byKey: Record<string, { rows: any[]; missing: boolean }> = {};
  withTable.forEach((m, i) => { byKey[m.key] = loaded[i]; });
  const entries = models.map((m) => entryFor(m, byKey[m.key] || null, MLB_DATASET,
    m.simDistributions ? sims.missing : undefined));
  const available = new Set(entries.filter((e) => e.available).map((e) => e.key));

  const grouped = Object.fromEntries(Object.entries(byKey)
    .map(([k, l]) => [k, groupBy(l.rows as ModelRow[], (r) => String(r.game_id))]));
  const simByGame = groupBy(sims.rows as SimDistRow[], (r) => (r.game_pk ?? r.game_id) == null
    ? null : String(r.game_pk ?? r.game_id));
  const playerGames = new Set(players.rows.map((r: any) => String(r.game_id)));

  const games = mergeMlbSpine(spine.rows, schedule).map((g) => {
    const startMs = g.start_time ? Date.parse(g.start_time) : null;
    const predictions: Record<string, SlatePrediction | null> = {};
    for (const m of models) {
      if (!available.has(m.key)) { predictions[m.key] = null; continue; }
      const pick = grouped[m.key] ? pickPrediction(grouped[m.key].get(g.game_id) || [], startMs) : null;
      const sim = m.simDistributions ? pickDist(simByGame.get(g.game_id) || [], startMs) : null;
      predictions[m.key] = buildPrediction(pick, sim,
        m.hasPlayers ? (!players.missing && playerGames.has(g.game_id)) : undefined);
    }
    return finishGame({ ...g, predictions }, available);
  });

  const isPast = date < todayEt();
  return {
    data: {
      sport: 'mlb',
      date,
      season,
      week: null,
      models: entries,
      featured_default: models.find((m) => m.role === 'production')?.key ?? null,
      games,
    },
    isPast,
    meta: {
      schedule_source: schedule ? 'mlb_api+bigquery' : 'bigquery',
      sim_distributions: sims.missing ? 'missing' : sims.rows.length,
      player_projections: players.missing ? 'missing' : players.rows.length,
    },
  };
}

/* ── football ────────────────────────────────────────────────────────── */

interface FootballSpineRow extends SpineRow {
  home_team_id?: string | null;
  away_team_id?: string | null;
  game_pk?: string | null;
  home_display?: string | null;
  away_display?: string | null;
  pk_home_score?: number | null;
  pk_away_score?: number | null;
  pk_completed?: boolean | null;
  total_line?: number | null;
  pred_spread_line?: number | null;
}

export function footballSpineGame(g: FootballSpineRow, nowMs = Date.now()): SpineGame & {
  week: number; completed: boolean; kickoff: string | null } {
  const start = toIso(g.kickoff);
  const histHs = finite(g.home_score);
  const histAs = finite(g.away_score);
  const hs = histHs ?? finite(g.pk_home_score);
  const as = histAs ?? finite(g.pk_away_score);
  const final = (histHs != null && histAs != null) || (Boolean(g.pk_completed) && hs != null && as != null);
  const startMs = start ? Date.parse(start) : null;
  let status: 'scheduled' | 'live' | 'final' = 'scheduled';
  let detail: string | null = null;
  if (final) status = 'final';
  else if (startMs != null && startMs <= nowMs) {
    if (nowMs - startMs < LIVE_WINDOW_MS) status = 'live';
    else { status = 'final'; detail = 'Result not ingested yet'; }
  }
  return {
    game_id: String(g.game_id),
    alt_id: g.game_pk == null ? null : String(g.game_pk),
    start_time: start,
    kickoff: start,
    week: Number(g.week),
    completed: final,
    status,
    status_detail: detail,
    home: team(g.home_team_id ?? g.home_team_name, g.home_display || g.home_team_name, g.home_team_id ?? null),
    away: team(g.away_team_id ?? g.away_team_name, g.away_display || g.away_team_name, g.away_team_id ?? null),
    result: { home_score: final ? hs : null, away_score: final ? as : null },
  };
}

/** The market as a model: its win probability, the spread as margin, the total. */
export function marketPrediction(sport: string, g: FootballSpineRow): SlatePrediction | null {
  const spread = finite(g.spread_line) ?? finite(g.pred_spread_line);
  const total = finite(g.total_line);
  const m = marketProbability(sport, { ...g, spread_line: spread });
  if (!m && spread == null && total == null) return null;
  return {
    home_win_prob: m ? Math.round(m.p * 1e6) / 1e6 : null,
    // A closing line is by nature the last price before kickoff.
    predicted_at: null,
    pregame: true,
    model_version: null,
    home_score: null,
    away_score: null,
    total: meanDist(total),
    margin: meanDist(spread),
    dist: null,
    extras: null,
    ...(m ? { basis: m.basis } : {}),
  };
}

async function buildFootballSlate(
  sport: FootballSportConfig, season: number, reqWeek: number | null, division: string | null,
) {
  const models = modelsForSport(sport.key) as ModelSource[];
  const withTable = models.filter((m) => m.table);
  const spineParams: Record<string, any> = { season, sport: sport.key };
  const spineTypes: Record<string, any> = {};
  if (sport.hasDivisions) { spineParams.division = division; spineTypes.division = 'STRING'; }
  const spineQ = () => bigquery.query({
    query: spineSql(sport, sport.hasDivisions, true), params: spineParams, types: spineTypes,
  }).then(([rows]) => rows as FootballSpineRow[]);
  const modelQ = (week: number) => Promise.all(withTable.map((m) => safeQuery(
    modelSql(sport.key, m, sport.seasonDataset, 'week', true), { season, week },
  )));

  let spine: FootballSpineRow[];
  let loaded: Array<{ rows: any[]; missing: boolean }>;
  let week: number | null;
  const nowMs = Date.now();
  if (reqWeek != null) {
    // Week known: the spine and the model rows can load together.
    [spine, loaded] = await Promise.all([spineQ(), modelQ(reqWeek)]);
    week = reqWeek;
  } else {
    spine = await spineQ();
    week = defaultWeek(spine.map((r) => footballSpineGame(r, nowMs)) as any, nowMs);
    loaded = week == null ? withTable.map(() => ({ rows: [], missing: false })) : await modelQ(week);
  }
  const weeks = [...new Set(spine.map((r) => Number(r.week)))].sort((a, b) => a - b);
  const weekRows = spine.filter((r) => Number(r.week) === week);
  const spineGames = weekRows.map((r) => footballSpineGame(r, nowMs));

  const anySim = models.some((m) => m.simDistributions);
  const dates = spineGames.map((g) => g.start_time?.slice(0, 10)).filter(Boolean).sort() as string[];
  const shift = (d: string, n: number) => {
    const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const sims = anySim && dates.length
    ? await safeQuery(simDistSql(sport.seasonDataset),
      { from: shift(dates[0], -1), to: shift(dates[dates.length - 1], 1) }, RANGE_TYPES)
    : { rows: [] as any[], missing: false };

  const byKey: Record<string, { rows: any[]; missing: boolean }> = {};
  withTable.forEach((m, i) => { byKey[m.key] = loaded[i]; });
  const marketRows = weekRows.map((r) => marketPrediction(sport.key, r));
  const marketN = marketRows.filter(Boolean).length;
  const entries = models.map((m) => {
    if (m.key === 'market') {
      return {
        key: m.key, label: m.label, role: m.role, available: marketN > 0,
        outputs: m.outputs || ['win_prob'], learn: m.learn ?? null, rows: marketN,
        note: marketN ? (sport.key === 'cfb'
          ? 'Win probability from the consensus spread, Φ(spread/15.5).'
          : 'De-vigged closing moneyline; the spread where no moneyline has landed.')
          : 'No lines stored for this week yet.',
      } as ModelEntry;
    }
    return entryFor(m, byKey[m.key] || null, sport.seasonDataset,
      m.simDistributions ? (sims.missing || !sims.rows.length) : undefined);
  });
  const available = new Set(entries.filter((e) => e.available).map((e) => e.key));
  const grouped = Object.fromEntries(Object.entries(byKey)
    .map(([k, l]) => [k, groupBy(l.rows as ModelRow[], (r) => String(r.game_id))]));
  const simByGame = groupBy(sims.rows as SimDistRow[], (r) => (r.game_id ?? r.game_pk) == null
    ? null : String(r.game_id ?? r.game_pk));

  const games = spineGames.map((g, i) => {
    const startMs = g.start_time ? Date.parse(g.start_time) : null;
    const predictions: Record<string, SlatePrediction | null> = {};
    for (const m of models) {
      if (m.key === 'market') { predictions.market = marketRows[i]; continue; }
      if (!available.has(m.key)) { predictions[m.key] = null; continue; }
      const pick = grouped[m.key] ? pickPrediction(grouped[m.key].get(g.game_id) || [], startMs) : null;
      // NFL sim rows may be keyed by game_id or by game_pk; accept either.
      const simRows = m.simDistributions
        ? [...(simByGame.get(g.game_id) || []), ...(g.alt_id ? simByGame.get(g.alt_id) || [] : [])]
        : [];
      const sim = m.simDistributions ? pickDist(simRows, startMs) : null;
      predictions[m.key] = buildPrediction(pick, sim);
    }
    const { alt_id, kickoff, completed, week: _w, ...pub } = g;
    return finishGame({ ...pub, predictions }, available);
  });

  const isPast = spineGames.length > 0 && spineGames.every((g) => g.status === 'final');
  return {
    data: {
      sport: sport.key,
      date: null,
      season,
      week,
      division,
      weeks,
      models: entries,
      featured_default: models.find((m) => m.role === 'production')?.key ?? null,
      games,
    },
    isPast,
    meta: {
      sim_distributions: sims.missing ? 'missing' : sims.rows.length,
    },
  };
}

/* ── response ────────────────────────────────────────────────────────── */

function parseFormat(req: Request, res: Response): Format | null {
  const f = String(req.query.format || '').toLowerCase();
  if (!f) return 'envelope';
  if (f === 'csv' || f === 'json') return f;
  res.status(400).json({
    success: false, error: { code: 'BAD_FORMAT', message: 'format must be csv or json' },
  });
  return null;
}

function badRequest(res: Response, message: string) {
  res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message } });
}

function send(
  res: Response, format: Format, data: any, meta: Record<string, any>, ttl: number,
  csv: () => { filename: string; body: string },
) {
  res.set('Cache-Control', `public, max-age=${ttl}`);
  if (format === 'csv') {
    const { filename, body } = csv();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
    return;
  }
  if (format === 'json') { res.json(data); return; }
  res.json({ success: true, data, meta });
}

async function cached<T>(
  key: string, build: () => Promise<{ value: T; ttl: number }>,
): Promise<{ value: T; ttl: number; hit: boolean }> {
  const hit = await cacheService.get<{ value: T; ttl: number }>(key);
  if (hit) return { ...hit, hit: true };
  const built = await build();
  try {
    if (Buffer.byteLength(JSON.stringify(built)) <= MAX_CACHED_BYTES) {
      void cacheService.set(key, built, built.ttl);
    }
  } catch (error: any) {
    logger.debug('unified slate: cache write failed', { key, error: error?.message });
  }
  return { ...built, hit: false };
}

/* ── handlers ────────────────────────────────────────────────────────── */

export async function getSlate(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const sport = String(req.params.sport || '').toLowerCase();
  const football = sport === 'mlb' ? null : getFootballSport(sport);
  if (!modelsForSport(sport) || (sport !== 'mlb' && !football)) {
    res.status(404).json({
      success: false, error: { code: 'UNKNOWN_SPORT', message: `Unknown sport: ${sport}` },
    });
    return;
  }
  const format = parseFormat(req, res);
  if (!format) return;

  try {
    let key: string;
    let build: () => Promise<{ value: any; ttl: number }>;
    if (!football) {
      if (req.query.date && !isDate(req.query.date)) { badRequest(res, 'date must be YYYY-MM-DD'); return; }
      const date = isDate(req.query.date) ? String(req.query.date) : todayEt();
      key = getCacheKey('pred:slate', { sport, date });
      build = async () => {
        const b = await buildMlbSlate(date);
        return { value: { data: b.data, meta: b.meta }, ttl: slateTtl(b.isPast) };
      };
    } else {
      const season = parseInt(String(req.query.season || ''), 10)
        || parseInt(process.env.CURRENT_SEASON || '', 10) || new Date().getUTCFullYear();
      const wRaw = req.query.week;
      const week = wRaw == null || wRaw === '' ? null : parseInt(String(wRaw), 10);
      if (week != null && (!Number.isFinite(week) || week < 0 || week > 30)) {
        badRequest(res, 'week must be an integer'); return;
      }
      let division: string | null = null;
      if (football.hasDivisions) {
        const d = String(req.query.division || 'fbs').toLowerCase();
        if (!['fbs', 'fcs', 'all'].includes(d)) { badRequest(res, 'division must be fbs, fcs or all'); return; }
        division = d === 'all' ? null : d;
      }
      // A defaulted week is keyed as such, so it moves on when the week does (5-minute TTL).
      key = getCacheKey('pred:slate', { sport, season, week: week ?? 'current', division: division ?? 'all' });
      build = async () => {
        const b = await buildFootballSlate(football, season, week, division);
        return { value: { data: b.data, meta: b.meta }, ttl: week == null ? slateTtl(false) : slateTtl(b.isPast) };
      };
    }
    const { value, ttl, hit } = await cached(key, build);
    const data = value.data;
    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    send(res, format, data, {
      ...value.meta,
      sport,
      count: data.games.length,
      rule: RULE,
      cache_ttl: ttl,
      elapsed_ms: Date.now() - started,
    }, ttl, () => ({
      filename: exportFilename('slate', sport, {
        date: data.date, season: data.season, week: data.week, division: data.division ?? null,
      }),
      body: toCsv(SLATE_CSV_HEADERS, slateCsvRows(data)),
    }));
  } catch (error: any) {
    logger.error('unified slate failed', { sport, error: error.message });
    res.status(500).json({
      success: false, error: { code: 'SLATE_ERROR', message: 'Failed to load the predictions slate' },
    });
  }
}

/** Latest pregame row per (game, player, stat); start times from BigQuery + MLB API. */
export function pickPlayerRows(rows: any[], starts: Map<string, number>): any[] {
  const grouped = groupBy(rows, (r) => `${r.game_pk}|${r.player_id}|${r.stat}`);
  const out: any[] = [];
  for (const group of grouped.values()) {
    const g = String(group[0].game_pk);
    const bqStart = toIso(group[0].game_time_utc);
    const startMs = starts.get(g) ?? (bqStart ? Date.parse(bqStart) : null);
    const picked = pickLatestPregameRow(group, startMs);
    if (picked) out.push({ ...picked.row, pregame: picked.pregame });
  }
  const order = (r: any) => [String(r.game_pk), String(r.team_id ?? ''), r.role === 'starter' ? 0 : 1,
    finite(r.batting_order) ?? 99, String(r.player_id), String(r.stat)];
  return out.sort((a, b) => {
    const x = order(a); const y = order(b);
    for (let i = 0; i < x.length; i += 1) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  });
}

export function playersSql(byGame: boolean): string {
  const filter = byGame ? 'CAST(game_pk AS STRING) = @game_id' : 'CAST(game_date AS DATE) = @date';
  return `
    WITH s AS (
      SELECT CAST(game_pk AS STRING) AS gk, MAX(game_time_utc) AS game_time_utc
      FROM ${table(MLB_DATASET, 'game_predictions')}
      WHERE ${filter}
      GROUP BY gk
    ),
    t AS (
      SELECT CAST(team_id AS STRING) AS tid, ANY_VALUE(team_code) AS team_abbr
      FROM ${table(MLB_DATASET, 'teams')}
      GROUP BY tid
    )
    SELECT p.*, s.game_time_utc, t.team_abbr
    FROM ${table(MLB_DATASET, PLAYER_PROJ_TABLE)} p
    LEFT JOIN s ON s.gk = CAST(p.game_pk AS STRING)
    LEFT JOIN t ON t.tid = CAST(p.team_id AS STRING)
    WHERE ${filter.replace(/game_pk|game_date/g, (c) => `p.${c}`)}`;
}

export async function getPlayers(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const sport = String(req.params.sport || '').toLowerCase();
  if (!modelsForSport(sport)) {
    res.status(404).json({
      success: false, error: { code: 'UNKNOWN_SPORT', message: `Unknown sport: ${sport}` },
    });
    return;
  }
  const format = parseFormat(req, res);
  if (!format) return;
  const gameId = req.query.game_id ? String(req.query.game_id) : null;
  if (gameId && !/^\d{1,12}$/.test(gameId)) { badRequest(res, 'game_id must be numeric'); return; }
  if (req.query.date && !isDate(req.query.date)) { badRequest(res, 'date must be YYYY-MM-DD'); return; }
  const date = gameId ? null : (isDate(req.query.date) ? String(req.query.date) : todayEt());
  const filename = () => exportFilename('players', sport, { date, gameId });

  if (sport !== 'mlb') {
    const data = {
      sport, available: false, date, game_id: gameId, rows: [],
      note: `No player projections for ${sport.toUpperCase()} yet.`,
    };
    send(res, format, data, { sport, count: 0 }, 3600,
      () => ({ filename: filename(), body: toCsv(PLAYER_CSV_HEADERS, []) }));
    return;
  }

  try {
    const key = getCacheKey('pred:players', { sport, date, game: gameId });
    const { value, ttl, hit } = await cached(key, async () => {
      const q = gameId
        ? await safeQuery(playersSql(true), { game_id: gameId })
        : await safeQuery(playersSql(false), { date }, DATE_TYPES);
      // First-pitch times from the schedule, for games no prediction row has timed yet.
      const starts = new Map<string, number>();
      const dates = gameId
        ? [...new Set(q.rows.map((r: any) => toIso(r.game_date)?.slice(0, 10)).filter(isDate))]
        : [date as string];
      if (q.rows.length) {
        for (const d of dates) {
          const schedule = await mlbApi.getScheduleWithOptions({ date: d, hydrate: 'team', cacheTtl: 120 })
            .catch(() => null);
          for (const day of schedule?.dates || []) {
            for (const g of day.games || []) {
              const ms = Date.parse(g.gameDate);
              if (Number.isFinite(ms)) starts.set(String(g.gamePk), ms);
            }
          }
        }
      }
      const rows = pickPlayerRows(q.rows, starts).map(normalizePlayerRow);
      const isPast = gameId
        ? rows.length > 0 && rows.every((r) => (r.game_date || '9999') < todayEt())
        : (date as string) < todayEt();
      return {
        value: {
          data: {
            sport,
            available: !q.missing,
            date,
            game_id: gameId,
            rows,
            note: q.missing ? `Not live yet: ${MLB_DATASET}.${PLAYER_PROJ_TABLE} has not been created.`
              : (rows.length ? null : 'No player projections for this selection yet.'),
          },
        },
        ttl: slateTtl(isPast),
      };
    });
    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    send(res, format, value.data, {
      sport, count: value.data.rows.length, table: `${MLB_DATASET}.${PLAYER_PROJ_TABLE}`,
      cache_ttl: ttl, elapsed_ms: Date.now() - started,
    }, ttl, () => ({ filename: filename(), body: toCsv(PLAYER_CSV_HEADERS, value.data.rows) }));
  } catch (error: any) {
    logger.error('unified players failed', { sport, error: error.message });
    res.status(500).json({
      success: false, error: { code: 'PLAYERS_ERROR', message: 'Failed to load player projections' },
    });
  }
}
