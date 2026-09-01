/**
 * Football team-stats endpoints, split by grain rather than by sport.
 *
 *   /stats/teams          one row = team x week   (NFL: team_week_epa)
 *   /stats/teams/season   one row = team x season (CFB: team_season_stats, 154 columns)
 *
 * They are separate routes because they are separate resources. A per-week game log and
 * a season total filter differently — the season table has no `week` column at all — and
 * one endpoint whose valid parameters change with :sport is how the college table ended
 * up unreachable in the first place.
 *
 * Neither returns SELECT *. 154 columns times 200 rows is several MB of JSON per
 * request, so callers get the `core` group by default and name what else they want. What
 * came back is described in meta.columns, so the client renders from the response rather
 * than from a hardcoded list of column names.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { datasetFor, FootballSportConfig } from '../config/football.config';
import {
  getColumnCatalog,
  resolveColumns,
  ColumnSpec,
} from '../config/football-columns.config';
import {
  resolveSport,
  isMissingTable,
  respondUnavailable,
  parsePaging,
  pickSort,
  sortDirection,
} from '../utils/football-request';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

/** Serialise the catalog for the wire. snake_case to match the rest of meta. */
function wireColumns(columns: ColumnSpec[]) {
  return columns.map((c) => ({
    key: c.key,
    label: c.label,
    group: c.group,
    format: c.format,
    higher_is_better: c.higherIsBetter ?? null,
    opponent: c.opponent ?? false,
  }));
}

/** Backtick-quote an identifier. Only ever called with allow-listed catalog keys. */
function quoteIdent(key: string): string {
  return `\`${key}\``;
}

/**
 * GET /api/football/:sport/stats/teams/season
 *
 * Per-team season totals. Params: season, team, search, group, fields, sort, direction,
 * limit, offset. `week` and `division` are accepted and ignored — the table carries
 * neither — and echoed back in meta.ignored_params so a caller sending them is told
 * rather than 500'd on `Unrecognized name: week`.
 */
export async function searchTeamSeasonStats(
  req: Request,
  res: Response,
): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  if (!sport.teamSeasonTable || !sport.teamSeasonColumnCatalog) {
    respondUnavailable(res, sport, 'per-team season stats');
    return;
  }

  const catalog = getColumnCatalog(sport.teamSeasonColumnCatalog);
  if (!catalog) {
    logger.error('football season catalog missing', {
      sport: sport.key, catalog: sport.teamSeasonColumnCatalog,
    });
    res.status(500).json({
      success: false,
      error: { code: 'CATALOG_ERROR', message: 'Failed to load column catalog' },
    });
    return;
  }

  const q = req.query as Record<string, string>;
  const allowedSort = sport.sortableSeasonFields || [];
  const sort = pickSort(q.sort, allowedSort, allowedSort[0] || 'season');
  if (!sort) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_SORT',
        message: `sort must be one of: ${allowedSort.join(', ')}`,
      },
    });
    return;
  }

  const { columns, unknown } = resolveColumns(catalog, {
    fields: q.fields, group: q.group,
  });

  // The sort column has to be in the projection or BigQuery cannot order by it.
  const projected = new Map(columns.map((c) => [c.key, c]));
  if (!projected.has(sort)) {
    const spec = catalog.columns.find((c) => c.key === sort);
    if (spec) projected.set(sort, spec);
  }
  const projection = [...projected.values()];

  // Params the table cannot satisfy. Ignored rather than passed to SQL: the season
  // table has no week or division column, and filtering on one raises
  // `Unrecognized name`, which reads as a server error rather than a bad request.
  const ignored = ['week', 'division'].filter((p) => q[p] !== undefined);

  try {
    const { limit, offset } = parsePaging(q, { limit: 50, max: 200 });
    const dir = sortDirection(q.direction);

    const filters: string[] = [];
    const params: Record<string, any> = { limit, offset };

    if (q.season) {
      filters.push('season = @season');
      params.season = parseInt(q.season, 10);
    }
    if (q.team) {
      filters.push('team = @team');
      params.team = q.team;
    }
    if (q.search) {
      filters.push('(LOWER(team) LIKE @search OR LOWER(team_abbr) LIKE @search)');
      params.search = `%${q.search.toLowerCase()}%`;
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const dataset = datasetFor(sport, sport.teamSeasonDataset);
    const table = `\`${PROJECT}.${dataset}.${sport.teamSeasonTable}\``;
    const select = projection.map((c) => quoteIdent(c.key)).join(', ');

    const [rows] = await bigquery.query({
      query: `SELECT ${select} FROM ${table} ${where} `
        + `ORDER BY ${quoteIdent(sort)} ${dir} LIMIT @limit OFFSET @offset`,
      params,
    });
    const [[{ total }]] = await bigquery.query({
      query: `SELECT COUNT(*) AS total FROM ${table} ${where}`,
      params,
    });

    res.json({
      success: true,
      data: rows,
      meta: {
        sport: sport.key,
        label: sport.label,
        scope: 'season',
        total,
        count: rows.length,
        limit,
        offset,
        sort,
        direction: dir,
        sortable_fields: allowedSort,
        group: q.fields ? null : (q.group || 'core'),
        groups: catalog.groups.map((gr) => ({
          key: gr.key,
          label: gr.label,
          count: catalog.columns.filter((c) => c.group === gr.key).length,
        })),
        columns: wireColumns(projection),
        coverage: sport.teamSeasonCoverage || null,
        week_endpoint: sport.statsTable
          ? `/api/football/${sport.key}/stats/teams`
          : null,
        ...(ignored.length ? { ignored_params: ignored } : {}),
        ...(unknown.length ? { unknown_fields: unknown } : {}),
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      logger.warn('football season stats table unavailable', {
        sport: sport.key, error: error.message,
      });
      respondUnavailable(
        res, sport, 'per-team season stats',
        `${sport.label} season stats are configured but not built yet.`,
      );
      return;
    }
    logger.error('football season stats search failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'STATS_ERROR', message: 'Failed to search team season stats' },
    });
  }
}

/**
 * GET /api/football/:sport/teams
 *
 * Team metadata — abbreviation, names, conference, colours, logos. Written by the ML
 * pipeline and until now unreachable, which is why football cards show plain team names.
 *
 * The row shape is canonical rather than nflverse's, so a second sport can satisfy it
 * without the client learning two vocabularies. `aliases` is built here on purpose: the
 * other football tables disagree about what a team is called — predictions carry
 * "Ohio State Buckeyes", rankings carry "Ohio State", team_week_epa carries "PHI" — and
 * one matcher in one place beats three in the client.
 */
export async function getTeams(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  if (!sport.teamsTable) {
    respondUnavailable(res, sport, 'team metadata');
    return;
  }

  const q = req.query as Record<string, string>;

  try {
    const { limit } = parsePaging(q, { limit: 400, max: 400 });
    const dataset = datasetFor(sport, sport.teamsDataset);
    const table = `\`${PROJECT}.${dataset}.${sport.teamsTable}\``;
    const games = `\`${PROJECT}.${sport.histDataset}.${sport.gamesTable}\``;

    const filters: string[] = [];
    const params: Record<string, any> = { limit };

    // nfl_historical.teams carries 36 rows for 32 clubs: relocated franchises
    // (OAK, SD, STL) keep their historical abbreviations. Anything rendering a current
    // league list wants the 32, so restrict to clubs that appear in the newest season.
    const activeOnly = (q.active ?? 'true').toLowerCase() !== 'false';
    if (activeOnly) {
      filters.push(`team_abbr IN (
        SELECT home_team FROM ${games}
        WHERE season = (SELECT MAX(season) FROM ${games})
        UNION DISTINCT
        SELECT away_team FROM ${games}
        WHERE season = (SELECT MAX(season) FROM ${games})
      )`);
    }
    if (q.conference) {
      filters.push('LOWER(team_conf) = @conference');
      params.conference = q.conference.toLowerCase();
    }
    if (q.search) {
      filters.push(
        '(LOWER(team_name) LIKE @search OR LOWER(team_abbr) LIKE @search '
        + 'OR LOWER(team_nick) LIKE @search)',
      );
      params.search = `%${q.search.toLowerCase()}%`;
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await bigquery.query({
      query: `
        SELECT team_abbr, team_name, team_nick, team_conf, team_division,
               team_color, team_color2, team_logo_espn, team_logo_squared,
               team_wordmark
        FROM ${table} ${where}
        ORDER BY team_name
        LIMIT @limit`,
      params,
    });

    const data = rows.map((r: any) => ({
      key: r.team_abbr,
      sport: sport.key,
      abbr: r.team_abbr,
      name: r.team_name,
      nick: r.team_nick,
      school: null,
      conference: r.team_conf,
      division: r.team_division,
      classification: null,
      primary_color: r.team_color,
      secondary_color: r.team_color2,
      logo: r.team_logo_espn,
      logo_squared: r.team_logo_squared,
      wordmark: r.team_wordmark,
      // Every spelling the other football tables use for this team, deduped.
      aliases: [...new Set(
        [r.team_abbr, r.team_name, r.team_nick].filter(Boolean),
      )],
    }));

    res.json({
      success: true,
      data,
      meta: {
        sport: sport.key,
        label: sport.label,
        count: data.length,
        active: activeOnly,
        source: 'nflverse',
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      logger.warn('football teams table unavailable', {
        sport: sport.key, error: error.message,
      });
      respondUnavailable(
        res, sport, 'team metadata',
        `${sport.label} team metadata is configured but not built yet.`,
      );
      return;
    }
    logger.error('football teams query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'TEAMS_ERROR', message: 'Failed to load teams' },
    });
  }
}
