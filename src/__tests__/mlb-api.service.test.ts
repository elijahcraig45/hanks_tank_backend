const mockGet = jest.fn();
const mockRequestUse = jest.fn();
const mockResponseUse = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      get: mockGet,
      interceptors: {
        request: { use: mockRequestUse },
        response: { use: mockResponseUse },
      },
    })),
    isAxiosError: jest.fn((error: unknown) => Boolean(error && (error as { isAxiosError?: boolean }).isAxiosError)),
  },
}));

jest.mock('../services/cache.service', () => ({
  cacheService: {
    get: mockCacheGet,
    set: mockCacheSet,
  },
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { MLBApiService } from '../services/mlb-api.service';

describe('MLBApiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockGet.mockResolvedValue({ data: { gamePk: 824447 } });
  });

  test('requests live game feeds from the StatsAPI v1.1 endpoint', async () => {
    const service = new MLBApiService();

    await service.getGameById(824447);

    expect(mockGet).toHaveBeenLastCalledWith(
      'https://statsapi.mlb.com/api/v1.1/game/824447/feed/live',
      { params: undefined }
    );
  });
});
