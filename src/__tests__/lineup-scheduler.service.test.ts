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

  it('schedules an immediate baseline task and a delayed refresh for future games', async () => {
    const service = new LineupSchedulerService();
    const scheduleSpy = jest.spyOn(service, 'schedulePregameTask').mockResolvedValue('task-name');
    const futureGame = {
      game_pk: 824450,
      game_date: '2026-04-20',
      game_time_utc: new Date(Date.now() + (3 * 60 * 60 * 1000)).toISOString(),
      home_team_name: 'Cleveland Guardians',
      away_team_name: 'Houston Astros',
    };

    const result = await service.scheduleAllGamesForDate([futureGame]);

    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    expect(scheduleSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      game_pks: [824450],
      delay_seconds: 0,
    }));
    expect(scheduleSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      game_pks: [824450],
      delay_seconds: expect.any(Number),
    }));
    expect(result.tasks.map(task => task.phase)).toEqual(['baseline', 'confirmed-refresh']);
    expect(result.tasks[1].delay_seconds).toBeGreaterThan(0);
  });
});
