/**
 * CFB scouting report: GET /api/football/cfb/scouting?season=&week=&division=fbs|fcs|all
 *
 * One card per game for a week, assembled from tables that already exist rather than a
 * new pipeline: the unified slate (every model's pick, consensus, the market), the power
 * rankings, the top producers per team from player_season_stats, and ESPN injuries.
 *
 * Everything past the slate is an enrichment. If a table is missing or ESPN is down the
 * report still renders, and meta says which parts are absent. Injuries are display-only:
 * the model does not use them, and ESPN covers almost no CFB teams, so an empty list means
 * "no data", never "healthy".
 *
 * Team names: the slate shows pick'em display names ("Arkansas") while rankings and ESPN
 * use the full names in game_predictions ("Arkansas Razorbacks"), and player_season_stats
 * uses the school name again. Full names are read from game_predictions and the player
 * table is matched on the longest school name the full name starts with.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { getFootballSport } from '../config/football.config';
import { getControl } from '../services/model-control.service';
import { getCfbInjuries, CfbInjury } from '../services/espn.service';
import { buildFootballSlate } from './unified-predictions.controller';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });
const table = (dataset: string, name: string) => `\`${PROJECT}.${dataset}.${name}\``;

type Rows = any[];
const num = (v: any): number | null => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

export function fullNamesSql(dataset: string): string {
  return `SELECT DISTINCT game_id, home_team_name, away_team_name
          FROM ${table(dataset, 'game_predictions')}
          WHERE season = @season AND week = @week`;
}

export function rankingsSql(dataset: string): string {
  return `
    SELECT team, \`rank\`, overall_rank, record, conference, division, as_of_week,
           results_rank, season_rank, forecast_rank, resume_rank,
           ap_rank, coaches_rank, playoff_pct, projected_wins, projected_losses
    FROM ${table(dataset, 'power_rankings')}
    WHERE season = @season AND model = 'margin' AND team IN UNNEST(@teams)
      AND as_of_week = (SELECT MAX(as_of_week) FROM ${table(dataset, 'power_rankings')}
                        WHERE season = @season AND model = 'margin')`;
}

/**
 * Top producers per team: the leading passer and rusher, two receivers and two
 * defenders by tackles. Players come back one row per (team, category).
 */
export function playersSql(dataset: string): string {
  const stats = table(dataset, 'player_season_stats');
  const i = (c: string) => `CAST(IFNULL(s.${c}, 0) AS INT64)`;
  return `
    WITH pt AS (SELECT DISTINCT team FROM ${stats} WHERE season = @season),
    m AS (
      SELECT n AS full_name, pt.team AS school
      FROM UNNEST(@teams) n JOIN pt ON STARTS_WITH(n, CONCAT(pt.team, ' ')) OR n = pt.team
      QUALIFY ROW_NUMBER() OVER (PARTITION BY n ORDER BY LENGTH(pt.team) DESC) = 1
    ),
    cand AS (
      SELECT m.full_name, c.cat, s.player_name, s.position, c.val, c.line,
             ROW_NUMBER() OVER (PARTITION BY m.full_name, c.cat ORDER BY c.val DESC) AS rk
      FROM m JOIN ${stats} s ON s.team = m.school AND s.season = @season
      CROSS JOIN UNNEST([
        STRUCT('pass' AS cat, s.passing_yds AS val,
               FORMAT('%d yds, %d TD, %d INT', ${i('passing_yds')}, ${i('passing_td')}, ${i('passing_int')}) AS line),
        STRUCT('rush', s.rushing_yds,
               FORMAT('%d yds, %d TD', ${i('rushing_yds')}, ${i('rushing_td')})),
        STRUCT('rec', s.receiving_yds,
               FORMAT('%d rec, %d yds, %d TD', ${i('receiving_rec')}, ${i('receiving_yds')}, ${i('receiving_td')})),
        STRUCT('def', s.defensive_tot,
               FORMAT('%d tackles, %d sacks, %d INT', ${i('defensive_tot')}, ${i('defensive_sacks')}, ${i('interceptions_int')}))
      ]) c
      WHERE c.val > 0
    )
    SELECT full_name, cat, player_name, position, line, rk
    FROM cand WHERE rk <= IF(cat IN ('pass', 'rush'), 1, 2)
    ORDER BY full_name, cat, rk`;
}

export function playersFreshnessSql(dataset: string): string {
  return `SELECT TIMESTAMP_MILLIS(last_modified_time) AS modified
          FROM ${table(dataset, '__TABLES__')} WHERE table_id = 'player_season_stats'`;
}

const CAT_ORDER = ['pass', 'rush', 'rec', 'def'];

/** Wrap an enrichment query: a failure yields no rows and a flag, never a failed report. */
async function enrich(label: string, run: () => Promise<Rows>): Promise<{ rows: Rows; ok: boolean }> {
  try {
    return { rows: await run(), ok: true };
  } catch (error: any) {
    logger.warn('cfb scouting enrichment failed', { label, error: error?.message });
    return { rows: [], ok: false };
  }
}

export async function getCfbScouting(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const sport = String(req.params.sport || '').toLowerCase();
  const football = sport === 'cfb' ? getFootballSport('cfb') : null;
  if (!football) {
    res.status(404).json({
      success: false,
      error: { code: 'UNKNOWN_SPORT', message: 'Scouting reports are available for college football (cfb) only' },
    });
    return;
  }

  const season = parseInt(String(req.query.season || ''), 10)
    || parseInt(process.env.CURRENT_SEASON || '', 10) || new Date().getUTCFullYear();
  const wRaw = req.query.week;
  const reqWeek = wRaw == null || wRaw === '' ? null : parseInt(String(wRaw), 10);
  if (reqWeek != null && (!Number.isFinite(reqWeek) || reqWeek < 0 || reqWeek > 30)) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'week must be an integer' } });
    return;
  }
  const d = String(req.query.division || 'fbs').toLowerCase();
  if (!['fbs', 'fcs', 'all'].includes(d)) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'division must be fbs, fcs or all' } });
    return;
  }
  const division = d === 'all' ? null : d;

  try {
    const control = await getControl('cfb');
    const slate = await buildFootballSlate(football, season, reqWeek, division, control);
    const { week, games: slateGames, models } = slate.data;
    const ds = football.seasonDataset;

    // Full team names for the slate's games (see the header on why).
    const names = week == null ? { rows: [], ok: true } : await enrich('names', () => bigquery
      .query({ query: fullNamesSql(ds), params: { season, week } }).then(([r]) => r));
    const fullById = new Map<string, { home: string; away: string }>(
      names.rows.map((r: any) => [String(r.game_id), { home: r.home_team_name, away: r.away_team_name }]));
    const teams = [...new Set([...fullById.values()].flatMap((n) => [n.home, n.away]).filter(Boolean))];

    const [ranks, players, fresh, injuries] = teams.length ? await Promise.all([
      enrich('rankings', () => bigquery.query({ query: rankingsSql(ds), params: { season, teams } }).then(([r]) => r)),
      enrich('players', () => bigquery.query({ query: playersSql(ds), params: { season, teams } }).then(([r]) => r)),
      enrich('freshness', () => bigquery.query({ query: playersFreshnessSql(ds) }).then(([r]) => r)),
      getCfbInjuries(),
    ]) : [{ rows: [], ok: true }, { rows: [], ok: true }, { rows: [], ok: true }, null];

    const rankByTeam = new Map<string, any>(ranks.rows.map((r: any) => [r.team, r]));
    const playersByTeam = new Map<string, any[]>();
    for (const r of players.rows) {
      (playersByTeam.get(r.full_name) || playersByTeam.set(r.full_name, []).get(r.full_name)!).push({
        category: r.cat, name: r.player_name, position: r.position, stat: r.line,
      });
    }
    for (const list of playersByTeam.values()) {
      list.sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
    }
    const rankingOf = (full: string | undefined) => {
      const r = full ? rankByTeam.get(full) : null;
      if (!r) return null;
      return {
        rank: num(r.rank), overall_rank: num(r.overall_rank), record: r.record ?? null,
        conference: r.conference ?? null, division: r.division ?? null,
        results_rank: num(r.results_rank), season_rank: num(r.season_rank),
        forecast_rank: num(r.forecast_rank), resume_rank: num(r.resume_rank),
        ap_rank: num(r.ap_rank), coaches_rank: num(r.coaches_rank),
        playoff_pct: num(r.playoff_pct),
        projected_wins: num(r.projected_wins), projected_losses: num(r.projected_losses),
      };
    };

    const modelLabel = new Map<string, string>(models.map((m: any) => [m.key, m.label]));
    const featured: string | null = slate.data.featured_default;
    const feed = injuries || {};

    const games = slateGames.map((g: any) => {
      const full = fullById.get(String(g.game_id));
      const side = (t: any, name: string | undefined) => {
        const inj: CfbInjury[] = name ? feed[name] || [] : [];
        return {
          ...t,
          full_name: name ?? null,
          ranking: rankingOf(name),
          key_players: name ? playersByTeam.get(name) || [] : [],
          injuries: inj,
        };
      };
      const home = side(g.home, full?.home);
      const away = side(g.away, full?.away);

      const modelRows = Object.entries(g.predictions as Record<string, any>)
        .filter(([k, p]) => k !== 'market' && p && p.home_win_prob != null)
        .map(([k, p]) => ({
          key: k, label: modelLabel.get(k) ?? k,
          home_win_prob: p.home_win_prob, margin: num(p.margin?.mean),
        }));
      const lead = (featured && modelRows.find((m) => m.key === featured)) || modelRows[0] || null;
      const p = lead?.home_win_prob ?? g.consensus?.home_win_prob_mean ?? null;
      const mk = g.predictions?.market;

      const ranks2 = [home.ranking?.overall_rank, away.ranking?.overall_rank]
        .filter((x): x is number => x != null);
      return {
        game_id: g.game_id, start_time: g.start_time, status: g.status, status_detail: g.status_detail,
        result: g.result, home, away,
        pick: p == null ? null : {
          model: lead?.key ?? 'consensus', label: lead?.label ?? 'Consensus',
          side: p >= 0.5 ? 'home' : 'away',
          team: (p >= 0.5 ? g.home : g.away).name,
          win_prob: Math.max(p, 1 - p), home_win_prob: p,
          model_margin: lead?.margin ?? null,
        },
        market: mk ? { home_win_prob: mk.home_win_prob, home_spread: num(mk.margin?.mean), total: num(mk.total?.mean) } : null,
        consensus: g.consensus, disagreement: g.disagreement,
        models: modelRows,
        injuries_available: home.injuries.length + away.injuries.length > 0,
        relevance: ranks2.length ? Math.min(...ranks2) : null,
      };
    }).sort((a: any, b: any) =>
      (a.relevance ?? 9999) - (b.relevance ?? 9999)
      || String(a.start_time).localeCompare(String(b.start_time)));

    const coverage = Object.keys(feed).length;
    res.json({
      success: true,
      data: { sport: 'cfb', season, week, division, weeks: slate.data.weeks, games },
      meta: {
        count: games.length,
        rankings_as_of_week: ranks.rows[0]?.as_of_week ?? null,
        player_stats_updated: fresh.rows[0]?.modified?.value ?? fresh.rows[0]?.modified ?? null,
        parts: {
          rankings: ranks.ok, players: players.ok, names: names.ok,
          injuries: injuries !== null,
        },
        injuries: {
          source: 'ESPN',
          teams_with_fresh_reports: coverage,
          note: coverage
            ? 'ESPN reports few CFB teams; a team with no entry has no data, not a clean bill of health.'
            : 'ESPN has no current CFB injury reports. This is missing data, not a clean bill of health.',
          used_by_model: false,
        },
        elapsed_ms: Date.now() - started,
      },
    });
  } catch (error: any) {
    logger.error('cfb scouting failed', { error: error?.message });
    res.status(500).json({ success: false, error: { code: 'SCOUTING_ERROR', message: 'Could not build the scouting report' } });
  }
}
