jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    queuePath: jest.fn().mockReturnValue('projects/hankstank/locations/us-central1/queues/lineup-pregame'),
    createTask: jest.fn(),
  })),
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { LineupSchedulerService } from '../services/lineup-scheduler.service';

describe('LineupSchedulerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('schedules an immediate baseline task plus repeated pregame refreshes for future games', async () => {
    const service = new LineupSchedulerService();
    const scheduleSpy = jest.spyOn(service, 'schedulePregameTask').mockResolvedValue('task-name');
    const futureGame = {
      game_pk: 824450,
      game_date: '2026-04-20',
      game_time_utc: new Date(Date.now() + (7 * 60 * 60 * 1000)).toISOString(),
      home_team_name: 'Cleveland Guardians',
      away_team_name: 'Houston Astros',
    };

    const result = await service.scheduleAllGamesForDate([futureGame]);

    expect(scheduleSpy).toHaveBeenCalledTimes(5);
    expect(scheduleSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      game_pks: [824450],
      delay_seconds: 0,
    }));
    expect(result.tasks[0].phase).toBe('baseline');
    expect(result.tasks.slice(1).map(task => task.phase)).toEqual([
      'lineup-refresh-360m',
      'lineup-refresh-180m',
      'lineup-refresh-90m',
      'lineup-refresh-45m',
    ]);
    result.tasks.slice(1).forEach((task) => {
      expect(task.delay_seconds).toBeGreaterThan(0);
    });
  });
  it('adds one sim-blend shadow task at the 90-minute checkpoint when its URL is set', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const scheduleSpy = jest.spyOn(service, 'schedulePregameTask').mockResolvedValue('task-name');
      const result = await service.scheduleAllGamesForDate([{
        game_pk: 824451,
        game_date: '2026-04-20',
        game_time_utc: new Date(Date.now() + (7 * 60 * 60 * 1000)).toISOString(),
        home_team_name: 'A',
        away_team_name: 'B',
      }]);
      expect(scheduleSpy).toHaveBeenCalledTimes(6);
      const simCalls = scheduleSpy.mock.calls.filter(([p]) => p.sim_blend);
      expect(simCalls).toHaveLength(1);
      expect(result.tasks.map(t => t.phase)).toContain('sim-blend-90m');
    } finally {
      delete process.env.SIM_BLEND_FUNCTION_URL;
    }
  });

  it('sends run_logit3 on pregame tasks and targets the sim function for sim tasks', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const create = (service as any).client.createTask as jest.Mock;
      create.mockResolvedValue([{ name: 't' }]);
      await service.schedulePregameTask({ game_pks: [1], game_date: '2026-04-20' });
      await service.schedulePregameTask({ game_pks: [1], game_date: '2026-04-20', sim_blend: true });
      const bodies = create.mock.calls.map(([req]) => ({
        url: req.task.httpRequest.url,
        body: JSON.parse(Buffer.from(req.task.httpRequest.body, 'base64').toString()),
      }));
      expect(bodies[0].body).toMatchObject({ mode: 'pregame_v10', run_logit3: true });
      expect(bodies[1].url).toBe('https://sim-blend.example');
      expect(bodies[1].body).toEqual({ mode: 'sim_blend', game_pks: [1], date: '2026-04-20' });
    } finally {
      delete process.env.SIM_BLEND_FUNCTION_URL;
    }
  });
});
