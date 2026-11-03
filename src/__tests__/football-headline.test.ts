/**
 * The football headline is the margin ridge (NFL since 2026 week 9, CFB from week 11); the XGBoost is a shadow on its own table.
 *
 * game_predictions holds XGBoost rows before the swap and ridge rows after it, so no model may read its record from that table: each model
 * reads its own table, and game_predictions is only the spine (the list of games) and the legacy headline endpoints.
 */
import { FOOTBALL_MODELS, REFERENCE_MODEL } from '../config/models.config';
import { COMPARE_MODELS } from '../config/football-models.config';
import { PRODUCTION_KEY } from '../utils/model-overlay';

describe('football headline', () => {
  it.each(['nfl', 'cfb'])('%s: the ridge is the only production model and the XGBoost a shadow on its own table', (sport) => {
    const models = FOOTBALL_MODELS[sport];
    const byKey = Object.fromEntries(models.map((m) => [m.key, m]));
    expect(models.filter((m) => m.role === 'production').map((m) => m.key)).toEqual(['ridge']);
    expect(byKey.ridge.table).toBe('game_predictions_ridge_shadow');
    expect(byKey.xgb).toEqual(expect.objectContaining({ role: 'shadow', table: 'game_predictions_xgb_shadow' }));
    expect(PRODUCTION_KEY[sport]).toBe('ridge');
    expect(REFERENCE_MODEL[sport]).toEqual(['market', 'ridge']);
  });

  it('no model reads its record from the headline table, which holds two models across the swap', () => {
    const tables = [...FOOTBALL_MODELS.nfl, ...FOOTBALL_MODELS.cfb, ...COMPARE_MODELS].map((m) => m.table);
    expect(tables).not.toContain('game_predictions');
    expect(COMPARE_MODELS.find((m) => m.key === 'xgb')?.table).toBe('game_predictions_xgb_shadow');
  });
});
