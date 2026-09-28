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
    const scheduleSpy = jest.spyOn(service, 'schedulePregameTask').mockResolvedValue({ name: 'task-name', deduped: false });
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
  it('adds sim-blend shadow tasks at T-80 and a lineup-fallback retry at T-35 when its URL is set', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const scheduleSpy = jest.spyOn(service, 'schedulePregameTask').mockResolvedValue({ name: 'task-name', deduped: false });
      const result = await service.scheduleAllGamesForDate([{
        game_pk: 824451,
        game_date: '2026-04-20',
        game_time_utc: new Date(Date.now() + (7 * 60 * 60 * 1000)).toISOString(),
        home_team_name: 'A',
        away_team_name: 'B',
      }]);
      expect(scheduleSpy).toHaveBeenCalledTimes(7);
      const simCalls = scheduleSpy.mock.calls.filter(([p]) => p.sim_blend).map(([p]) => p);
      expect(simCalls).toHaveLength(2);
      expect(simCalls.map(p => Boolean(p.lineup_fallback))).toEqual([false, true]);
      expect(result.tasks.map(t => t.phase)).toEqual(expect.arrayContaining(['sim-blend-80m', 'sim-blend-35m']));
      expect(result.tasks.map(t => t.phase)).not.toContain('sim-blend-90m');
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

  it('puts sim tasks on their own queue and pregame tasks on lineup-pregame', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const client = (service as any).client;
      client.createTask.mockResolvedValue([{ name: 't' }]);
      await service.schedulePregameTask({ game_pks: [1], game_date: '2026-04-20' });
      await service.schedulePregameTask({ game_pks: [1], game_date: '2026-04-20', sim_blend: true, lineup_fallback: true });
      const queues = client.queuePath.mock.calls.map((c: string[]) => c[2]);
      expect(queues).toEqual(['lineup-pregame', 'sim-blend']);
      const body = JSON.parse(Buffer.from(client.createTask.mock.calls[1][0].task.httpRequest.body, 'base64').toString());
      expect(body).toEqual({ mode: 'sim_blend', game_pks: [1], date: '2026-04-20', lineup_fallback: true });
    } finally {
      delete process.env.SIM_BLEND_FUNCTION_URL;
    }
  });

  it('a second schedule-today call enqueues nothing: identical tasks share a name', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const client = (service as any).client;
      const existing = new Set<string>();
      // Cloud Tasks semantics: a named task that exists is rejected with ALREADY_EXISTS (6)
      client.createTask.mockImplementation(async ({ task }: any) => {
        if (task.name && existing.has(task.name)) {
          throw Object.assign(new Error('6 ALREADY_EXISTS: Requested entity already exists'), { code: 6 });
        }
        if (task.name) existing.add(task.name);
        return [{ name: task.name || 'auto' }];
      });
      const game = {
        game_pk: 823650,
        game_date: '2026-09-27',
        game_time_utc: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
        home_team_name: 'Minnesota Twins',
        away_team_name: 'Texas Rangers',
      };
      const first = await service.scheduleAllGamesForDate([game]);
      // the ML function's schedule_pregame_tasks call, 2 minutes after App Engine cron
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 1000);
      const second = await service.scheduleAllGamesForDate([game]);
      (Date.now as jest.Mock).mockRestore();

      expect(first.scheduled).toBe(7);          // baseline + 4 refreshes + 2 sim
      expect(first.deduped).toBe(0);
      expect(second.scheduled).toBe(0);
      expect(second.deduped).toBe(7);
      expect(existing.size).toBe(7);
      for (const name of existing) {
        expect(name).toMatch(/^projects\/hankstank\/locations\/us-central1\/queues\/lineup-pregame\/tasks\/[0-9a-f]{16}-[A-Za-z0-9_-]+$/);
      }
    } finally {
      delete process.env.SIM_BLEND_FUNCTION_URL;
    }
  });

  it('a postponed game (first pitch moved) gets new tasks', async () => {
    const service = new LineupSchedulerService();
    const client = (service as any).client;
    const names: string[] = [];
    client.createTask.mockImplementation(async ({ task }: any) => { names.push(task.name); return [{ name: task.name }]; });
    const t = Date.now() + 7 * 60 * 60 * 1000;
    const g = { game_pk: 1, game_date: '2026-09-27', home_team_name: 'H', away_team_name: 'A' };
    await service.scheduleAllGamesForDate([{ ...g, game_time_utc: new Date(t).toISOString() }]);
    await service.scheduleAllGamesForDate([{ ...g, game_time_utc: new Date(t + 3600e3).toISOString() }]);
    const refresh = names.filter(n => /-t\d+-/.test(n));
    expect(new Set(refresh).size).toBe(refresh.length);
    expect(names.filter(n => n.endsWith('-baseline'))).toHaveLength(2);   // same name: deduped by Cloud Tasks
    expect(new Set(names.filter(n => n.endsWith('-baseline'))).size).toBe(1);
  });

  it('other createTask errors still throw for pregame tasks', async () => {
    const service = new LineupSchedulerService();
    const client = (service as any).client;
    client.createTask.mockRejectedValue(Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }));
    await expect(service.schedulePregameTask({ game_pks: [1], game_date: '2026-04-20', dedupe_key: 'k' }))
      .rejects.toThrow('PERMISSION_DENIED');
  });

  it('a failing sim queue never costs the pregame tasks', async () => {
    process.env.SIM_BLEND_FUNCTION_URL = 'https://sim-blend.example';
    try {
      const service = new LineupSchedulerService();
      const client = (service as any).client;
      client.createTask.mockImplementation(async ({ parent }: any) => {
        if (String(parent).endsWith('/sim-blend')) throw Object.assign(new Error('5 NOT_FOUND: queue'), { code: 5 });
        return [{ name: 'ok' }];
      });
      client.queuePath.mockImplementation((p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`);
      const r = await service.scheduleAllGamesForDate([{
        game_pk: 2, game_date: '2026-09-27', home_team_name: 'H', away_team_name: 'A',
        game_time_utc: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
      }]);
      expect(r.scheduled).toBe(5);
      expect(r.skipped).toBe(0);
      expect(r.tasks.map(t => t.phase)).not.toContain('sim-blend-80m');
    } finally {
      delete process.env.SIM_BLEND_FUNCTION_URL;
    }
  });
});
