/**
 * GET /api/football/:sport/models/compare?season=&week=&division=
 *
 * Every model's prediction for each game side by side, plus a season-to-date scoreboard
 * scored only on predictions written before kickoff. EXPERIMENT: the ridge and FPI
 * tables it reads do not exist in production yet; until they do, those models come
 * back `available: false` with a note, and the page says so instead of erroring.
 *
 * Shape:
 *   data.models      registry + availability, one entry per model incl. the market
 *   data.games       the requested week's games, each with predictions[model]
 *   data.scoreboard  { per_model, head_to_head } over the whole season (not the week)
 *   data.week_scoreboard  same, for the requested week only
 *   data.weeks       weeks that have games, for the selector
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { FootballSportConfig, datasetFor } from '../config/football.config';
import { MARKET_KEY, modelsFor, CompareModelSource } from '../config/football-models.config';
import { resolveSport, isMissingTable } from '../utils/football-request';
import {
  buildComparison, buildScoreboard, defaultWeek, ModelRow, SpineRow,
} from '../utils/football-compare';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const PICKEM_DATASET = process.env.PICKEM_DATASET || 'pickem';
const bigquery = new BigQuery({ projectId: PROJECT });

const table = (dataset: string, name: string) => `\`${PROJECT}.${dataset}.${name}\``;

/**
 * One row per game the production model predicted, with its result, kickoff and line.
 *
 * The spine is the production table because it is the only source covering upcoming
 * games in both sports: nfl_historical.games and cfb_historical.games hold completed
 * games only. A game production never predicted does not appear — documented, and
 * rare, since it predicts every scheduled game in a week.
 *
 * Kickoff: pickem.games carries the real UTC kickoff for this season's pickable games.
 * Otherwise the NFL's comes from nflverse's Eastern wall-clock gameday/gametime (the
 * prediction row's game_date is a date, not a kickoff), and college's from the
 * prediction row's game_date, which is ESPN's kickoff timestamp.
 */
export function spineSql(
  sport: FootballSportConfig, hasDivision: boolean, detail = false,
): string {
  const preds = table(sport.seasonDataset, sport.predictionsTable);
  const games = table(sport.histDataset, sport.gamesTable);
  const pickem = table(PICKEM_DATASET, 'games');
  const isNfl = sport.key === 'nfl';

  const kickoff = isNfl
    ? `TIMESTAMP(DATETIME(SAFE.PARSE_DATE('%Y-%m-%d', g.gameday),
                          SAFE.PARSE_TIME('%H:%M', g.gametime)), 'America/New_York')`
    : 'p.game_date';
  const lines = sport.linesTable
    ? `LEFT JOIN (
         SELECT game_id, ANY_VALUE(spread_line) AS spread_line${detail ? ', ANY_VALUE(total_line) AS total_line' : ''}
         FROM ${table(datasetFor(sport, sport.linesDataset), sport.linesTable)}
         GROUP BY game_id
       ) l ON l.game_id = p.game_id`
    : '';
  const spread = sport.linesTable ? 'l.spread_line' : 'g.spread_line';
  // detail: the unified slate also needs team ids, display names, the total and the
  // pick'em feed's live scores (nfl_historical.games only holds completed weeks).
  const totalLine = sport.linesTable ? 'l.total_line' : 'g.total_line';
  const detailP = detail
    ? `ANY_VALUE(home_team_id) AS home_team_id, ANY_VALUE(away_team_id) AS away_team_id,
             ${isNfl ? 'ANY_VALUE(spread_line) AS pred_spread_line,' : 'CAST(NULL AS FLOAT64) AS pred_spread_line,'}
             ${isNfl ? 'ANY_VALUE(CAST(game_pk AS STRING))' : 'CAST(NULL AS STRING)'} AS game_pk,`
    : '';
  const detailSelect = detail
    ? `p.home_team_id, p.away_team_id, p.game_pk,
           pk.home_display, pk.away_display,
           pk.home_score AS pk_home_score, pk.away_score AS pk_away_score,
           pk.completed AS pk_completed,
           COALESCE(${totalLine}, pk.total_line) AS total_line,
           p.pred_spread_line,`
    : '';
  const moneylines = isNfl
    ? 'g.home_moneyline, g.away_moneyline'
    : 'CAST(NULL AS FLOAT64) AS home_moneyline, CAST(NULL AS FLOAT64) AS away_moneyline';

  return `
    WITH p AS (
      SELECT game_id,
             ANY_VALUE(season) AS season, ANY_VALUE(week) AS week,
             ${hasDivision ? 'ANY_VALUE(division)' : 'CAST(NULL AS STRING)'} AS division,
             ANY_VALUE(home_team_name) AS home_team_name,
             ANY_VALUE(away_team_name) AS away_team_name,
             ${detailP}
             MIN(game_date) AS game_date
      FROM ${preds}
      WHERE season = @season ${hasDivision ? 'AND (@division IS NULL OR division = @division)' : ''}
      GROUP BY game_id
    )
    SELECT p.game_id, p.season, p.week, p.division, p.home_team_name, p.away_team_name,
           ${detailSelect}
           g.home_score, g.away_score, g.home_won,
           COALESCE(pk.kickoff, ${kickoff}) AS kickoff,
           COALESCE(${spread}, pk.spread_line) AS spread_line,
           ${moneylines}
    FROM p
    LEFT JOIN ${games} g ON g.game_id = p.game_id
    ${lines}
    LEFT JOIN ${pickem} pk ON pk.sport = @sport AND pk.game_id = p.game_id
    ORDER BY p.week, kickoff, p.game_id`;
}

function modelSql(sport: FootballSportConfig, m: CompareModelSource): string {
  const margin = m.hasMargin ? 'predicted_home_margin' : 'CAST(NULL AS FLOAT64)';
  return `
    SELECT game_id, home_win_probability, ${margin} AS predicted_home_margin,
           predicted_at, model_version
    FROM ${table(sport.seasonDataset, m.table)}
    WHERE season = @season`;
}

interface ModelStatus {
  key: string;
  label: string;
  available: boolean;
  planned: boolean;
  has_margin: boolean;
  rows: number;
  note: string | null;
}

/** Load one model's rows; a table that is not built yet is a state, not an error. */
async function loadModel(
  sport: FootballSportConfig, m: CompareModelSource, params: Record<string, any>,
): Promise<{ rows: ModelRow[]; status: ModelStatus }> {
  const base = {
    key: m.key, label: m.label, planned: Boolean(m.planned), has_margin: m.hasMargin,
  };
  if (m.planned) {
    return {
      rows: [],
      status: { ...base, available: false, rows: 0, note: 'Planned — not built yet.' },
    };
  }
  try {
    const [rows] = await bigquery.query({ query: modelSql(sport, m), params });
    return {
      rows: rows as ModelRow[],
      status: {
        ...base,
        available: rows.length > 0,
        rows: rows.length,
        note: rows.length ? null : `No ${m.label} predictions for this season yet.`,
      },
    };
  } catch (error: any) {
    if (!isMissingTable(error)) throw error;
    logger.warn('compare: model table unavailable', {
      sport: sport.key, model: m.key, error: error.message,
    });
    return {
      rows: [],
      status: {
        ...base, available: false, rows: 0,
        note: `${sport.seasonDataset}.${m.table} has not been created yet.`,
      },
    };
  }
}

export async function getModelComparison(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  const season = parseInt((req.query.season as string) || '', 10)
    || parseInt(process.env.CURRENT_SEASON || '', 10)
    || new Date().getUTCFullYear();
  const division = sport.hasDivisions && req.query.division
    ? String(req.query.division).toLowerCase()
    : null;
  const requestedWeek = parseInt((req.query.week as string) || '', 10);

  try {
    const params: Record<string, any> = { season, sport: sport.key };
    const spineParams: Record<string, any> = { ...params };
    const spineTypes: Record<string, string> = {};
    if (sport.hasDivisions) {
      spineParams.division = division;
      // A null parameter needs its type spelled out or BigQuery rejects the query.
      spineTypes.division = 'STRING';
    }

    const models = modelsFor(sport.key);
    const [[spine], ...loaded] = await Promise.all([
      bigquery.query({
        query: spineSql(sport, sport.hasDivisions),
        params: spineParams,
        types: spineTypes,
      }),
      ...models.map((m) => loadModel(sport, m, params)),
    ]);

    const sources: Record<string, ModelRow[]> = {};
    models.forEach((m, i) => { if (!m.planned) sources[m.key] = loaded[i].rows; });

    const games = buildComparison(sport.key, spine as SpineRow[], sources);
    const scored = [...Object.keys(sources), MARKET_KEY];
    const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
    const week = Number.isFinite(requestedWeek) ? requestedWeek : defaultWeek(games);
    const weekGames = games.filter((g) => g.week === week);

    const statuses: ModelStatus[] = loaded.map((l) => l.status);
    statuses.push({
      key: MARKET_KEY,
      label: 'Betting market',
      available: games.some((g) => g.predictions[MARKET_KEY]),
      planned: false,
      has_margin: true,
      rows: games.filter((g) => g.predictions[MARKET_KEY]).length,
      note: null,
    });

    res.json({
      success: true,
      data: {
        sport: sport.key,
        season,
        week,
        division,
        weeks,
        models: statuses,
        games: weekGames,
        scoreboard: buildScoreboard(games, scored),
        week_scoreboard: buildScoreboard(weekGames, scored),
      },
      meta: {
        sport: sport.key,
        label: sport.label,
        count: weekGames.length,
        season_games: games.length,
        rule: 'Scored only on predictions written strictly before kickoff; the '
          + 'latest such row per game. Ties and unplayed games are not scored.',
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({
        success: true,
        data: null,
        meta: { sport: sport.key, note: `${sport.label} predictions are not built yet.` },
      });
      return;
    }
    logger.error('football model comparison failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'COMPARE_ERROR', message: 'Failed to load the model comparison' },
    });
  }
}
