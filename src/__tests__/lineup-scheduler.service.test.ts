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
});
